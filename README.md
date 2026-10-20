# Project Portfolio

A lightweight, static project portfolio website designed with clean editorial typography reminiscent of a classic WordPress blog. Built exclusively with static HTML and CSS.

---

## 📂 Structure

Each project is self-contained in its own folder inside `projects/`, containing its dedicated HTML page and picture assets:

```text
qwirty123.github.io/
├── index.html                     # Simple homepage linking to all projects
├── css/
│   └── style.css                  # Shared editorial blog styling & typography
├── projects/
│   ├── distributed-cache/
│   │   ├── index.html             # Project article / case study
│   │   ├── architecture.svg       # Architecture diagram
│   │   └── benchmark.svg          # Benchmark chart
│   ├── markdown-notes/
│   │   ├── index.html             # Project article / case study
│   │   ├── editor-preview.svg     # App preview image
│   │   └── file-tree.svg          # Data flow diagram
│   ├── audio-synthesizer/
│   │   ├── index.html             # Project article / case study
│   │   ├── synth-interface.svg    # Synth UI diagram
│   │   └── signal-flow.svg        # DSP pipeline diagram
│   └── cli-task-manager/
│       ├── index.html             # Project article / case study
│       ├── tui-preview.svg        # Terminal interface screenshot
│       └── shortcuts.svg          # Keybinding reference
└── README.md
```

---

## ✍️ How to Add a New Project

Adding a new project is straightforward:

1. **Create a new folder** under `projects/` (e.g., `projects/my-new-project/`).
2. **Add your images / diagrams** into that folder (e.g., `screenshot.png`, `diagram.svg`).
3. **Add an `index.html`** in that folder (you can copy an existing project's `index.html` as a template).
4. **Link to it on the homepage (`index.html`)** by adding an `<article class="project-entry">` block:

```html
<article class="project-entry">
  <a href="projects/my-new-project/index.html" class="entry-image-link">
    <img src="projects/my-new-project/screenshot.png" alt="Project Preview" class="entry-image">
  </a>
  <div class="entry-meta">Category &bull; Month Year</div>
  <h2 class="entry-title">
    <a href="projects/my-new-project/index.html">My New Project</a>
  </h2>
  <p class="entry-description">
    A short two-sentence description of the project.
  </p>
  <div>
    <a href="projects/my-new-project/index.html" class="read-more-link">Read project case study &rarr;</a>
  </div>
</article>
```

---

## 💻 Local Testing

Run with any static local web server:

```bash
python -m http.server 8000
```

Then visit `http://localhost:8000/`.

---

## 🚀 Deployment to GitHub Pages

Commit and push to the default `main` branch:

```bash
git add .
git commit -m "Update simple blog-style portfolio"
git push origin main
```
