import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  computeBoundsTree,
  disposeBoundsTree,
  acceleratedRaycast
} from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ============================================================================
// Web Worker for Binary & ASCII PLY Parsing + Vertex Normals
// ============================================================================
const PLY_WORKER_CODE = `
self.onmessage = function(e) {
  const { buffer } = e.data;
  try {
    const result = parsePLY(buffer);
    const transfer = [result.positions.buffer];
    if (result.colors) transfer.push(result.colors.buffer);
    if (result.normals) transfer.push(result.normals.buffer);
    if (result.indices) transfer.push(result.indices.buffer);
    self.postMessage({ ok: true, ...result }, transfer);
  } catch (err) {
    self.postMessage({ ok: false, error: err.message || String(err) });
  }
};

function parsePLY(buffer) {
  const bytes = new Uint8Array(buffer);
  let headerEnd = 0;
  const maxHeaderSearch = Math.min(bytes.length, 65536);
  let headerText = '';
  for (let i = 0; i < maxHeaderSearch; i++) {
    if (
      bytes[i] === 101 && bytes[i + 1] === 110 && bytes[i + 2] === 100 &&
      bytes[i + 3] === 95 && bytes[i + 4] === 104 && bytes[i + 5] === 101 &&
      bytes[i + 6] === 97 && bytes[i + 7] === 100 && bytes[i + 8] === 101 &&
      bytes[i + 9] === 114
    ) {
      let j = i + 10;
      if (bytes[j] === 13) j++;
      if (bytes[j] === 10) j++;
      headerEnd = j;
      headerText = new TextDecoder('ascii').decode(bytes.subarray(0, headerEnd));
      break;
    }
  }
  if (!headerEnd) throw new Error('Invalid PLY file: end_header not found');

  const lines = headerText.split(/\\r?\\n/);
  let format = 'ascii';
  const elements = [];
  let currentElement = null;

  const typeSize = {
    char: 1, int8: 1, uchar: 1, uint8: 1,
    short: 2, int16: 2, ushort: 2, uint16: 2,
    int: 4, int32: 4, uint: 4, uint32: 4,
    float: 4, float32: 4,
    double: 8, float64: 8
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('comment') || line === 'ply' || line === 'end_header') continue;
    const parts = line.split(/\\s+/);
    const keyword = parts[0];
    if (keyword === 'format') {
      format = parts[1];
    } else if (keyword === 'element') {
      currentElement = { name: parts[1], count: parseInt(parts[2], 10), properties: [] };
      elements.push(currentElement);
    } else if (keyword === 'property' && currentElement) {
      if (parts[1] === 'list') {
        currentElement.properties.push({
          isList: true, countType: parts[2], itemType: parts[3], name: parts[4]
        });
      } else {
        currentElement.properties.push({
          isList: false, type: parts[1], size: typeSize[parts[1]] || 4, name: parts[2]
        });
      }
    }
  }

  const vertexElem = elements.find(el => el.name === 'vertex');
  const faceElem = elements.find(el => el.name === 'face');
  if (!vertexElem) throw new Error('PLY file does not contain a vertex element');

  const numVertices = vertexElem.count;
  const numFaces = faceElem ? faceElem.count : 0;

  const positions = new Float32Array(numVertices * 3);
  let colors = null;
  let normals = null;
  let indices = null;

  let vertexStride = 0;
  let isFixedStrideVertex = true;
  const propMap = {};
  for (const p of vertexElem.properties) {
    if (p.isList) { isFixedStrideVertex = false; break; }
    propMap[p.name] = { offset: vertexStride, type: p.type, size: p.size };
    vertexStride += p.size;
  }

  const hasColor = ('red' in propMap && 'green' in propMap && 'blue' in propMap) ||
                   ('r' in propMap && 'g' in propMap && 'b' in propMap) ||
                   ('diffuse_red' in propMap && 'diffuse_green' in propMap && 'diffuse_blue' in propMap);
  const hasNormals = ('nx' in propMap && 'ny' in propMap && 'nz' in propMap);

  if (hasColor) colors = new Uint8Array(numVertices * 3);
  if (hasNormals) normals = new Float32Array(numVertices * 3);

  const dv = new DataView(buffer);
  const littleEndian = format === 'binary_little_endian';

  if (format === 'binary_little_endian' || format === 'binary_big_endian') {
    let offset = headerEnd;
    const px = propMap.x, py = propMap.y, pz = propMap.z;
    const pr = propMap.red || propMap.r || propMap.diffuse_red;
    const pg = propMap.green || propMap.g || propMap.diffuse_green;
    const pb = propMap.blue || propMap.b || propMap.diffuse_blue;
    const pnx = propMap.nx, pny = propMap.ny, pnz = propMap.nz;

    const isStandardFloatXYZ =
      littleEndian && isFixedStrideVertex && px && py && pz &&
      px.type === 'float' && py.type === 'float' && pz.type === 'float' &&
      px.offset === 0 && py.offset === 4 && pz.offset === 8;

    if (isStandardFloatXYZ) {
      const rOff = pr ? pr.offset : -1;
      const gOff = pg ? pg.offset : -1;
      const bOff = pb ? pb.offset : -1;
      const isUcharColor = pr && (pr.type === 'uchar' || pr.type === 'uint8');

      for (let i = 0; i < numVertices; i++) {
        const base = offset + i * vertexStride;
        const i3 = i * 3;
        positions[i3]     = dv.getFloat32(base, true);
        positions[i3 + 1] = dv.getFloat32(base + 4, true);
        positions[i3 + 2] = dv.getFloat32(base + 8, true);

        if (colors) {
          if (isUcharColor) {
            colors[i3]     = bytes[base + rOff];
            colors[i3 + 1] = bytes[base + gOff];
            colors[i3 + 2] = bytes[base + bOff];
          } else {
            colors[i3]     = Math.min(255, Math.max(0, Math.round(readProp(dv, base + rOff, pr.type, true) * 255)));
            colors[i3 + 1] = Math.min(255, Math.max(0, Math.round(readProp(dv, base + gOff, pg.type, true) * 255)));
            colors[i3 + 2] = Math.min(255, Math.max(0, Math.round(readProp(dv, base + bOff, pb.type, true) * 255)));
          }
        }
        if (normals) {
          normals[i3]     = dv.getFloat32(base + pnx.offset, true);
          normals[i3 + 1] = dv.getFloat32(base + pny.offset, true);
          normals[i3 + 2] = dv.getFloat32(base + pnz.offset, true);
        }
      }
      offset += numVertices * vertexStride;
    } else {
      for (let i = 0; i < numVertices; i++) {
        const base = offset + i * vertexStride;
        const i3 = i * 3;
        positions[i3]     = readProp(dv, base + px.offset, px.type, littleEndian);
        positions[i3 + 1] = readProp(dv, base + py.offset, py.type, littleEndian);
        positions[i3 + 2] = readProp(dv, base + pz.offset, pz.type, littleEndian);
        if (colors) {
          const rVal = readProp(dv, base + pr.offset, pr.type, littleEndian);
          const gVal = readProp(dv, base + pg.offset, pg.type, littleEndian);
          const bVal = readProp(dv, base + pb.offset, pb.type, littleEndian);
          const scale = (pr.type === 'float' || pr.type === 'float32' || pr.type === 'double') ? 255 : 1;
          colors[i3]     = Math.min(255, Math.max(0, Math.round(rVal * scale)));
          colors[i3 + 1] = Math.min(255, Math.max(0, Math.round(gVal * scale)));
          colors[i3 + 2] = Math.min(255, Math.max(0, Math.round(bVal * scale)));
        }
        if (normals) {
          normals[i3]     = readProp(dv, base + pnx.offset, pnx.type, littleEndian);
          normals[i3 + 1] = readProp(dv, base + pny.offset, pny.type, littleEndian);
          normals[i3 + 2] = readProp(dv, base + pnz.offset, pnz.type, littleEndian);
        }
      }
      offset += numVertices * vertexStride;
    }

    if (numFaces > 0 && faceElem) {
      const faceProp = faceElem.properties[0];
      const isFastTriUcharUint =
        littleEndian && faceElem.properties.length === 1 && faceProp.isList &&
        (faceProp.countType === 'uchar' || faceProp.countType === 'uint8') &&
        (faceProp.itemType === 'uint' || faceProp.itemType === 'uint32' || faceProp.itemType === 'int' || faceProp.itemType === 'int32');

      const remainingBytes = bytes.length - offset;
      if (isFastTriUcharUint && remainingBytes >= numFaces * 13 && bytes[offset] === 3) {
        indices = new Uint32Array(numFaces * 3);
        let fOff = offset;
        let outIdx = 0;
        let allTriangles = true;
        for (let f = 0; f < numFaces; f++) {
          if (bytes[fOff] !== 3) { allTriangles = false; break; }
          indices[outIdx++] = dv.getUint32(fOff + 1, true);
          indices[outIdx++] = dv.getUint32(fOff + 5, true);
          indices[outIdx++] = dv.getUint32(fOff + 9, true);
          fOff += 13;
        }
        if (!allTriangles) {
          indices = parseGeneralBinaryFaces(dv, offset, numFaces, faceElem.properties, littleEndian, typeSize);
        }
      } else {
        indices = parseGeneralBinaryFaces(dv, offset, numFaces, faceElem.properties, littleEndian, typeSize);
      }
    }
  } else {
    const bodyText = new TextDecoder('ascii').decode(bytes.subarray(headerEnd));
    const bodyLines = bodyText.split(/\\r?\\n/);
    let lineIdx = 0;
    const propNames = vertexElem.properties.map(p => p.name);
    const ix = propNames.indexOf('x'), iy = propNames.indexOf('y'), iz = propNames.indexOf('z');
    const ir = propNames.indexOf('red') !== -1 ? propNames.indexOf('red') : propNames.indexOf('r');
    const ig = propNames.indexOf('green') !== -1 ? propNames.indexOf('green') : propNames.indexOf('g');
    const ib = propNames.indexOf('blue') !== -1 ? propNames.indexOf('blue') : propNames.indexOf('b');

    for (let i = 0; i < numVertices; i++) {
      while (lineIdx < bodyLines.length && !bodyLines[lineIdx].trim()) lineIdx++;
      if (lineIdx >= bodyLines.length) break;
      const parts = bodyLines[lineIdx++].trim().split(/\\s+/);
      const i3 = i * 3;
      positions[i3] = parseFloat(parts[ix]);
      positions[i3 + 1] = parseFloat(parts[iy]);
      positions[i3 + 2] = parseFloat(parts[iz]);
      if (colors && ir !== -1) {
        colors[i3] = parseInt(parts[ir], 10);
        colors[i3 + 1] = parseInt(parts[ig], 10);
        colors[i3 + 2] = parseInt(parts[ib], 10);
      }
    }

    if (numFaces > 0) {
      const triIndices = [];
      for (let f = 0; f < numFaces; f++) {
        while (lineIdx < bodyLines.length && !bodyLines[lineIdx].trim()) lineIdx++;
        if (lineIdx >= bodyLines.length) break;
        const parts = bodyLines[lineIdx++].trim().split(/\\s+/);
        const n = parseInt(parts[0], 10);
        const v0 = parseInt(parts[1], 10);
        for (let k = 1; k < n - 1; k++) {
          triIndices.push(v0, parseInt(parts[1 + k], 10), parseInt(parts[2 + k], 10));
        }
      }
      indices = new Uint32Array(triIndices);
    }
  }

  if (!normals && indices && indices.length > 0) {
    normals = computeVertexNormals(positions, indices);
  }

  return { positions, colors, normals, indices };
}

function readProp(dv, offset, type, le) {
  switch (type) {
    case 'float': case 'float32': return dv.getFloat32(offset, le);
    case 'double': case 'float64': return dv.getFloat64(offset, le);
    case 'uchar': case 'uint8': return dv.getUint8(offset);
    case 'char': case 'int8': return dv.getInt8(offset);
    case 'ushort': case 'uint16': return dv.getUint16(offset, le);
    case 'short': case 'int16': return dv.getInt16(offset, le);
    case 'uint': case 'uint32': return dv.getUint32(offset, le);
    case 'int': case 'int32': return dv.getInt32(offset, le);
    default: return dv.getFloat32(offset, le);
  }
}

function parseGeneralBinaryFaces(dv, startOffset, numFaces, properties, le, typeSize) {
  let offset = startOffset;
  const triList = [];
  for (let f = 0; f < numFaces; f++) {
    for (const p of properties) {
      if (p.isList) {
        const count = readProp(dv, offset, p.countType, le);
        offset += typeSize[p.countType] || 1;
        const itemSz = typeSize[p.itemType] || 4;
        if (p.name === 'vertex_indices' || p.name === 'vertex_index') {
          const v0 = readProp(dv, offset, p.itemType, le);
          for (let k = 1; k < count - 1; k++) {
            triList.push(
              v0,
              readProp(dv, offset + k * itemSz, p.itemType, le),
              readProp(dv, offset + (k + 1) * itemSz, p.itemType, le)
            );
          }
        }
        offset += count * itemSz;
      } else {
        offset += p.size;
      }
    }
  }
  return new Uint32Array(triList);
}

function computeVertexNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0, len = indices.length; i < len; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const e1x = positions[b] - ax, e1y = positions[b + 1] - ay, e1z = positions[b + 2] - az;
    const e2x = positions[c] - ax, e2y = positions[c + 1] - ay, e2z = positions[c + 2] - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }
  for (let i = 0, len = normals.length; i < len; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (l > 1e-10) {
      const inv = 1 / l;
      normals[i] *= inv; normals[i + 1] *= inv; normals[i + 2] *= inv;
    }
  }
  return normals;
}
`;

const UNIT_CONFIG = {
  m:  { factor: 1.0,       decimals: 4, label: 'm' },
  cm: { factor: 100.0,     decimals: 2, label: 'cm' },
  mm: { factor: 1000.0,    decimals: 1, label: 'mm' },
  in: { factor: 39.370079, decimals: 2, label: 'in' },
  ft: { factor: 3.28084,   decimals: 3, label: 'ft' }
};

const state = {
  shadingMode: 'unlit',
  unit: 'cm',
  rulerActive: false,
  pendingPointA: null,
  hoverPointLocal: null,
  measurements: [],
  selectedMeasurementId: null,
  nextMeasurementId: 1,
  modelRadius: 0.6,
  markerScale: 0.008
};

// DOM References
const viewportEl = document.getElementById('viewport-container');
const canvasEl = document.getElementById('three-canvas');
const labelsContainer = document.getElementById('labels-container');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingTitle = document.getElementById('loading-title');
const loadingStatus = document.getElementById('loading-status');
const loadingBar = document.getElementById('loading-bar');

const btnRuler = document.getElementById('btn-ruler');
const btnClearMeasurements = document.getElementById('btn-clear-measurements');
const btnResetView = document.getElementById('btn-reset-view');
const btnFullscreen = document.getElementById('btn-fullscreen');
const unitSelect = document.getElementById('unit-select');
const shadingSelect = document.getElementById('shading-select');

const rulerHud = document.getElementById('ruler-hud');
const rulerStepText = document.getElementById('ruler-step-text');
const rulerReadout = document.getElementById('ruler-readout');
const liveDistanceValEl = document.getElementById('live-distance-val');
const liveDxEl = document.getElementById('live-dx');
const liveDyEl = document.getElementById('live-dy');
const liveDzEl = document.getElementById('live-dz');

// ============================================================================
// Three.js Scene & Renderer
// ============================================================================
THREE.ColorManagement.enabled = false;
const renderer = new THREE.WebGLRenderer({
  canvas: canvasEl,
  antialias: true,
  powerPreference: 'high-performance'
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.005, 100);
const controls = new OrbitControls(camera, canvasEl);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;

const hemiLight = new THREE.HemisphereLight(0xffffff, 0x334155, 1.35);
hemiLight.position.set(0, 5, 0);
scene.add(hemiLight);

const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.25);
dirLight1.position.set(3, 5, 4);
scene.add(dirLight1);

const dirLight2 = new THREE.DirectionalLight(0x93c5fd, 0.65);
dirLight2.position.set(-4, -2, -3);
scene.add(dirLight2);

const gridHelper = new THREE.GridHelper(2.0, 20, 0x38bdf8, 0x1e293b);
gridHelper.material.transparent = true;
gridHelper.material.opacity = 0.45;
scene.add(gridHelper);

// Z-up to Y-up pivot
const scanPivot = new THREE.Group();
scanPivot.rotation.set(-Math.PI / 2, 0, 0);
scene.add(scanPivot);

const modelContainer = new THREE.Group();
scanPivot.add(modelContainer);

const measurementsGroup = new THREE.Group();
modelContainer.add(measurementsGroup);

const previewGroup = new THREE.Group();
modelContainer.add(previewGroup);

const reticleGroup = createSurfaceReticle();
scene.add(reticleGroup);

const previewLabelEl = document.createElement('div');
previewLabelEl.className = 'measure-label-3d preview-label';
previewLabelEl.style.display = 'none';
labelsContainer.appendChild(previewLabelEl);

let currentGeometry = null;
let currentMesh = null;
let currentPoints = null;
let materials = {};

const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
const pointerNDC = new THREE.Vector2();

const workerBlob = new Blob([PLY_WORKER_CODE], { type: 'application/javascript' });
const plyWorker = new Worker(URL.createObjectURL(workerBlob));

function createSurfaceReticle() {
  const group = new THREE.Group();
  group.visible = false;

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.65, 1.0, 32),
    new THREE.MeshBasicMaterial({
      color: 0xfbbf24, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false
    })
  );
  ring.renderOrder = 999;
  group.add(ring);

  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.25, 20),
    new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide, depthTest: false })
  );
  dot.renderOrder = 1000;
  group.add(dot);
  return group;
}

// ============================================================================
// Single-File PLY Loader
// ============================================================================
async function loadPLY(url) {
  loadingOverlay.classList.remove('hidden');
  loadingTitle.textContent = `Loading ${url}…`;
  loadingStatus.textContent = 'Downloading 3D scan…';
  loadingBar.style.width = '5%';

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} loading ${url}`);

    const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
    let arrayBuffer;

    if (response.body && contentLength > 0) {
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        const pct = Math.min(75, Math.round((received / contentLength) * 75));
        loadingStatus.textContent = `${(received / 1048576).toFixed(1)} / ${(contentLength / 1048576).toFixed(1)} MB`;
        loadingBar.style.width = `${pct}%`;
      }
      const combined = new Uint8Array(received);
      let pos = 0;
      for (const chunk of chunks) {
        combined.set(chunk, pos);
        pos += chunk.byteLength;
      }
      arrayBuffer = combined.buffer;
    } else {
      arrayBuffer = await response.arrayBuffer();
    }

    loadingStatus.textContent = 'Parsing geometry & normals…';
    loadingBar.style.width = '85%';

    const parsed = await new Promise((resolve, reject) => {
      plyWorker.onmessage = (e) => (e.data.ok ? resolve(e.data) : reject(new Error(e.data.error)));
      plyWorker.onerror = reject;
      plyWorker.postMessage({ buffer: arrayBuffer }, [arrayBuffer]);
    });

    loadingStatus.textContent = 'Indexing 3D surface…';
    loadingBar.style.width = '95%';
    await new Promise((r) => setTimeout(r, 15));

    buildScene(parsed);
    loadingOverlay.classList.add('hidden');
  } catch (err) {
    console.error(err);
    loadingTitle.textContent = 'Failed to load PLY';
    loadingStatus.textContent = err.message;
  }
}

function buildScene(parsed) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(parsed.positions, 3));

  const hasColors = Boolean(parsed.colors);
  if (hasColors) {
    geometry.setAttribute('color', new THREE.Uint8BufferAttribute(parsed.colors, 3, true));
  }
  if (parsed.normals) {
    geometry.setAttribute('normal', new THREE.BufferAttribute(parsed.normals, 3));
  }
  if (parsed.indices && parsed.indices.length > 0) {
    geometry.setIndex(new THREE.BufferAttribute(parsed.indices, 1));
  }

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  if (geometry.index) geometry.computeBoundsTree();
  currentGeometry = geometry;

  materials = {
    lit: new THREE.MeshStandardMaterial({
      vertexColors: hasColors, color: hasColors ? 0xffffff : 0x94a3b8, roughness: 0.72, metalness: 0.04, side: THREE.DoubleSide
    }),
    unlit: new THREE.MeshBasicMaterial({
      vertexColors: hasColors, color: hasColors ? 0xffffff : 0x94a3b8, side: THREE.DoubleSide
    }),
    clay: new THREE.MeshStandardMaterial({
      color: 0xd1d5db, roughness: 0.55, metalness: 0.08, side: THREE.DoubleSide
    }),
    wireframe: new THREE.MeshBasicMaterial({
      vertexColors: hasColors, color: hasColors ? 0xffffff : 0x38bdf8, wireframe: true
    }),
    points: new THREE.PointsMaterial({
      size: 2.0, sizeAttenuation: false, vertexColors: hasColors, color: hasColors ? 0xffffff : 0x38bdf8
    })
  };

  currentMesh = new THREE.Mesh(geometry, materials[state.shadingMode]);
  modelContainer.add(currentMesh);

  currentPoints = new THREE.Points(geometry, materials.points);
  currentPoints.visible = false;
  modelContainer.add(currentPoints);

  // Center scan at origin
  const center = new THREE.Vector3();
  geometry.boundingBox.getCenter(center);
  modelContainer.position.copy(center).negate();
  scanPivot.updateMatrixWorld(true);

  const worldBox = new THREE.Box3().setFromObject(currentMesh);
  const size = new THREE.Vector3();
  worldBox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z, 0.1);

  state.modelRadius = geometry.boundingSphere ? geometry.boundingSphere.radius : maxDim * 0.5;
  state.markerScale = Math.max(0.002, state.modelRadius * 0.012);

  gridHelper.position.y = worldBox.min.y - 0.002;
  gridHelper.scale.setScalar(Math.max(0.5, maxDim * 0.9));

  fitCamera();
}

function fitCamera() {
  if (!currentMesh) return;
  const r = Math.max(0.1, state.modelRadius);
  const dist = r * 2.1;
  controls.target.set(0, 0, 0);
  camera.position.set(dist * 0.72, dist * 0.52, dist * 0.82);
  camera.near = Math.max(0.001, r * 0.005);
  camera.far = Math.max(50, r * 40);
  camera.updateProjectionMatrix();
  controls.update();
}

// ============================================================================
// 3D Surface Picking & 2-Point Ruler
// ============================================================================
function pickSurfacePoint(clientX, clientY) {
  if (!currentMesh || !currentGeometry) return null;
  const rect = canvasEl.getBoundingClientRect();
  pointerNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointerNDC, camera);
  const prevVisible = currentMesh.visible;
  currentMesh.visible = true;

  const hits = currentGeometry.index
    ? raycaster.intersectObject(currentMesh, false)
    : raycaster.intersectObject(currentPoints, false);

  currentMesh.visible = prevVisible;
  if (hits.length === 0) return null;

  const hit = hits[0];
  const worldPoint = hit.point.clone();
  const localPoint = modelContainer.worldToLocal(worldPoint.clone());

  const worldNormal = new THREE.Vector3(0, 1, 0);
  if (hit.face) {
    worldNormal.copy(hit.face.normal).transformDirection(currentMesh.matrixWorld).normalize();
    if (worldNormal.dot(raycaster.ray.direction) > 0) worldNormal.negate();
  } else {
    worldNormal.copy(camera.position).sub(worldPoint).normalize();
  }

  return { worldPoint, localPoint, worldNormal };
}

function formatDistance(meters) {
  const u = UNIT_CONFIG[state.unit];
  return `${(meters * u.factor).toFixed(u.decimals)} ${u.label}`;
}

function formatSignedDelta(meters) {
  const u = UNIT_CONFIG[state.unit];
  const val = meters * u.factor;
  return `${val >= 0 ? '+' : ''}${val.toFixed(u.decimals)} ${u.label}`;
}

function toggleRulerMode(force) {
  state.rulerActive = typeof force === 'boolean' ? force : !state.rulerActive;
  btnRuler.classList.toggle('active', state.rulerActive);
  viewportEl.classList.toggle('ruler-cursor', state.rulerActive);

  if (!state.rulerActive) {
    cancelPendingMeasurement();
    reticleGroup.visible = false;
  }
  updateHudState();
}

function cancelPendingMeasurement() {
  state.pendingPointA = null;
  clearGroup(previewGroup);
  previewLabelEl.style.display = 'none';
  updateHudState();
}

function createEndpointSphere(localPos, colorHex) {
  const group = new THREE.Group();
  group.position.copy(localPos);
  const geo = new THREE.SphereGeometry(state.markerScale, 18, 18);

  group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: colorHex })));

  const xray = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.45, depthTest: false })
  );
  xray.renderOrder = 990;
  group.add(xray);
  return group;
}

function createRulerSegment3D(pA, pB, colorHex) {
  const group = new THREE.Group();
  group.add(createEndpointSphere(pA, colorHex));
  group.add(createEndpointSphere(pB, colorHex));

  const lineGeo = new THREE.BufferGeometry().setFromPoints([pA, pB]);
  group.add(new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: colorHex })));

  const xrayLine = new THREE.Line(
    lineGeo,
    new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity: 0.55, depthTest: false })
  );
  xrayLine.renderOrder = 985;
  group.add(xrayLine);

  // ΔX, ΔY, ΔZ projection legs
  const corner1 = new THREE.Vector3(pB.x, pA.y, pA.z);
  const corner2 = new THREE.Vector3(pB.x, pB.y, pA.z);
  const addLeg = (v1, v2, c) => {
    if (v1.distanceToSquared(v2) < 1e-10) return;
    const l = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([v1, v2]),
      new THREE.LineDashedMaterial({
        color: c, dashSize: state.markerScale * 2, gapSize: state.markerScale * 1.4,
        transparent: true, opacity: 0.8, depthTest: false
      })
    );
    l.computeLineDistances();
    l.renderOrder = 980;
    group.add(l);
  };
  addLeg(pA, corner1, 0xf87171);
  addLeg(corner1, corner2, 0x4ade80);
  addLeg(corner2, pB, 0x60a5fa);

  return group;
}

function updateLivePreview(hoverLocal) {
  clearGroup(previewGroup);
  if (!state.pendingPointA) return;

  if (!hoverLocal) {
    previewGroup.add(createEndpointSphere(state.pendingPointA, 0x38bdf8));
    previewLabelEl.style.display = 'none';
    return;
  }

  const pA = state.pendingPointA;
  const pB = hoverLocal;
  previewGroup.add(createRulerSegment3D(pA, pB, 0x38bdf8));

  const dist = pA.distanceTo(pB);
  setReadoutValues(dist, pB.x - pA.x, pB.y - pA.y, pB.z - pA.z);

  const midWorld = modelContainer.localToWorld(new THREE.Vector3().addVectors(pA, pB).multiplyScalar(0.5));
  previewLabelEl.textContent = formatDistance(dist);
  positionHtmlOverlay(previewLabelEl, midWorld);
}

function finalizeMeasurement(pA, pB) {
  const id = state.nextMeasurementId++;
  const dist = pA.distanceTo(pB);
  const dx = pB.x - pA.x, dy = pB.y - pA.y, dz = pB.z - pA.z;

  const group3D = createRulerSegment3D(pA, pB, 0xfbbf24);
  measurementsGroup.add(group3D);

  const labelEl = document.createElement('div');
  labelEl.className = 'measure-label-3d';
  labelsContainer.appendChild(labelEl);

  const badgeA = document.createElement('div');
  badgeA.className = 'endpoint-badge-3d';
  badgeA.textContent = 'A';
  labelsContainer.appendChild(badgeA);

  const badgeB = document.createElement('div');
  badgeB.className = 'endpoint-badge-3d';
  badgeB.textContent = 'B';
  labelsContainer.appendChild(badgeB);

  const record = { id, pA: pA.clone(), pB: pB.clone(), distance: dist, dx, dy, dz, group3D, labelEl, badgeA, badgeB };
  state.measurements.push(record);

  labelEl.addEventListener('click', (e) => {
    e.stopPropagation();
    state.selectedMeasurementId = id;
    updateHudState();
  });

  state.selectedMeasurementId = id;
  cancelPendingMeasurement();
  updateLabelsText();
  updateHudState();
}

function deleteMeasurement(id) {
  const idx = state.measurements.findIndex((m) => m.id === id);
  if (idx === -1) return;
  const m = state.measurements[idx];
  measurementsGroup.remove(m.group3D);
  disposeObject3D(m.group3D);
  m.labelEl.remove();
  m.badgeA.remove();
  m.badgeB.remove();
  state.measurements.splice(idx, 1);

  if (state.selectedMeasurementId === id) {
    const last = state.measurements[state.measurements.length - 1];
    state.selectedMeasurementId = last ? last.id : null;
  }
  updateHudState();
}

function clearAllMeasurements() {
  cancelPendingMeasurement();
  for (const m of state.measurements) {
    measurementsGroup.remove(m.group3D);
    disposeObject3D(m.group3D);
    m.labelEl.remove();
    m.badgeA.remove();
    m.badgeB.remove();
  }
  state.measurements = [];
  state.selectedMeasurementId = null;
  state.nextMeasurementId = 1;
  updateHudState();
}

function updateLabelsText() {
  for (const m of state.measurements) {
    m.labelEl.innerHTML = `<span>${formatDistance(m.distance)}</span><button class="del-btn" title="Remove">✕</button>`;
    m.labelEl.querySelector('.del-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteMeasurement(m.id);
    });
  }
}

function setReadoutValues(dist, dx, dy, dz) {
  rulerReadout.classList.remove('hidden');
  liveDistanceValEl.textContent = formatDistance(dist);
  liveDxEl.textContent = formatSignedDelta(dx);
  liveDyEl.textContent = formatSignedDelta(dy);
  liveDzEl.textContent = formatSignedDelta(dz);
}

function updateHudState() {
  btnClearMeasurements.disabled = state.measurements.length === 0 && !state.pendingPointA;

  for (const m of state.measurements) {
    m.labelEl.classList.toggle('selected', m.id === state.selectedMeasurementId);
  }

  const sel = state.measurements.find((m) => m.id === state.selectedMeasurementId) ||
              state.measurements[state.measurements.length - 1];

  if (!state.rulerActive && !sel) {
    rulerHud.classList.add('hidden');
    return;
  }

  rulerHud.classList.remove('hidden');

  if (state.rulerActive) {
    rulerStepText.textContent = state.pendingPointA
      ? 'Click Point B to finish measurement (Esc to cancel)'
      : 'Ruler Active: Click Point A on the 3D scan';
  } else if (sel) {
    rulerStepText.textContent = `Measurement #${sel.id}`;
  }

  if (!state.pendingPointA) {
    if (sel) {
      setReadoutValues(sel.distance, sel.dx, sel.dy, sel.dz);
    } else {
      rulerReadout.classList.add('hidden');
    }
  }
}

// ============================================================================
// 2D Overlay Projection & Pointer Events
// ============================================================================
const tempProj = new THREE.Vector3();

function positionHtmlOverlay(el, worldPos) {
  tempProj.copy(worldPos).project(camera);
  if (tempProj.z > 1.0 || tempProj.z < -1.0) {
    el.style.display = 'none';
    return;
  }
  const rect = canvasEl.getBoundingClientRect();
  el.style.display = 'flex';
  el.style.left = `${(tempProj.x * 0.5 + 0.5) * rect.width}px`;
  el.style.top = `${(-tempProj.y * 0.5 + 0.5) * rect.height}px`;
}

function updateMeasurementOverlays() {
  for (const m of state.measurements) {
    const worldA = modelContainer.localToWorld(m.pA.clone());
    const worldB = modelContainer.localToWorld(m.pB.clone());
    const midWorld = new THREE.Vector3().addVectors(worldA, worldB).multiplyScalar(0.5);
    positionHtmlOverlay(m.labelEl, midWorld);
    positionHtmlOverlay(m.badgeA, worldA);
    positionHtmlOverlay(m.badgeB, worldB);
  }
  if (state.pendingPointA && state.hoverPointLocal) {
    const midWorld = modelContainer.localToWorld(
      new THREE.Vector3().addVectors(state.pendingPointA, state.hoverPointLocal).multiplyScalar(0.5)
    );
    positionHtmlOverlay(previewLabelEl, midWorld);
  }
}

let pointerDownPos = { x: 0, y: 0 };
let pointerDownButton = -1;

canvasEl.addEventListener('pointerdown', (e) => {
  pointerDownPos.x = e.clientX;
  pointerDownPos.y = e.clientY;
  pointerDownButton = e.button;
});

canvasEl.addEventListener('pointermove', (e) => {
  if (!currentMesh || !state.rulerActive) return;

  const hit = pickSurfacePoint(e.clientX, e.clientY);
  if (hit) {
    state.hoverPointLocal = hit.localPoint;
    reticleGroup.visible = true;
    reticleGroup.position.copy(hit.worldPoint).addScaledVector(hit.worldNormal, state.markerScale * 0.25);
    reticleGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hit.worldNormal);
    reticleGroup.scale.setScalar(camera.position.distanceTo(hit.worldPoint) * 0.014);

    if (state.pendingPointA) updateLivePreview(hit.localPoint);
  } else {
    state.hoverPointLocal = null;
    reticleGroup.visible = false;
    if (state.pendingPointA) updateLivePreview(null);
  }
});

canvasEl.addEventListener('pointerup', (e) => {
  if (pointerDownButton !== 0 || !state.rulerActive) return;
  if (Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y) > 5) return;

  const hit = pickSurfacePoint(e.clientX, e.clientY);
  if (!hit) return;

  if (!state.pendingPointA) {
    state.pendingPointA = hit.localPoint.clone();
    updateLivePreview(hit.localPoint);
    updateHudState();
  } else {
    finalizeMeasurement(state.pendingPointA, hit.localPoint);
  }
});

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT') return;
  const key = e.key.toLowerCase();
  if (key === 'r' || key === 'm') toggleRulerMode();
  else if (key === 'escape') {
    if (state.pendingPointA) cancelPendingMeasurement();
    else if (state.rulerActive) toggleRulerMode(false);
  } else if (key === 'f') fitCamera();
  else if (key === 'c') clearAllMeasurements();
});

btnRuler.addEventListener('click', () => toggleRulerMode());
btnClearMeasurements.addEventListener('click', () => clearAllMeasurements());
btnResetView.addEventListener('click', () => fitCamera());

if (btnFullscreen) {
  btnFullscreen.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {
        window.open(window.location.href, '_blank');
      });
    } else {
      document.exitFullscreen();
    }
  });
}

unitSelect.addEventListener('change', () => {
  state.unit = unitSelect.value;
  updateLabelsText();
  updateHudState();
  if (state.pendingPointA && state.hoverPointLocal) {
    updateLivePreview(state.hoverPointLocal);
  }
});

shadingSelect.addEventListener('change', () => {
  state.shadingMode = shadingSelect.value;
  if (!currentMesh || !currentPoints) return;
  if (state.shadingMode === 'points') {
    currentMesh.visible = false;
    currentPoints.visible = true;
  } else {
    currentMesh.visible = true;
    currentPoints.visible = false;
    currentMesh.material = materials[state.shadingMode] || materials.lit;
  }
});

function clearGroup(group) {
  while (group.children.length > 0) {
    const child = group.children[0];
    group.remove(child);
    disposeObject3D(child);
  }
}

function disposeObject3D(obj) {
  obj.traverse((c) => {
    if (c.geometry) c.geometry.dispose();
    if (c.material) {
      if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
      else c.material.dispose();
    }
  });
}

function handleResize() {
  const w = viewportEl.clientWidth;
  const h = viewportEl.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}

window.addEventListener('resize', handleResize);
handleResize();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
  updateMeasurementOverlays();
}
animate();

// Load the single PLY file specified via ?model= or ?src= (defaults to Model1.ply)
const params = new URLSearchParams(window.location.search);
const targetModel = params.get('model') || params.get('src') || 'Model1.ply';
loadPLY(targetModel);
