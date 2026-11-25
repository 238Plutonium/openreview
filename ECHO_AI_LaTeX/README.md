# ECHO-AI LaTeX source

Open `main.tex` as the main document. This package includes the ACL style file,
all three figure assets, and the corresponding formatted PDF.

Compile with pdfLaTeX twice:

```sh
pdflatex main.tex
pdflatex main.tex
```

For Overleaf, upload the ZIP, select `main.tex` as the main document, and use
pdfLaTeX. References are embedded in `main.tex`; no BibTeX run is required.

## Editing with automatic reflow

Edit the prose in `main.tex`, then select Recompile. Removing text automatically
moves the following text up and repaginates the document. Body paragraphs are
ordinary flowing text, without fixed-position text boxes or manual line breaks.
Figures and tables float automatically; the appendix starts on a new page.

## Architecture figure

`architecture_paper.py` is the editable drawing source for Figure 1. The compiled
vector PDF is already included; normal LaTeX compilation needs no Python tools.
To redraw the figure, run the script in this directory with ReportLab and PyMuPDF
installed, then recompile the paper.
