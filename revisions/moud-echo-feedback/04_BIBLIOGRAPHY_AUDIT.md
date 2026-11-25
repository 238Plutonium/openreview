# Bibliography audit (ECHO_AI_LaTeX/main.tex @ close-eval-gaps)

## Method
Extracted author–year callouts from the manuscript body (including multi-cite forms such as `Arora et al., 2010, 2011a` and `Hu et al., 2023, 2026`) and compared them to `\bibitem` labels.

## Findings
1. **Label mismatch (fixed in this revision):** body cites `Robertson and Zaragoza, 2009` but bibitem label was `Robertson et al.(2009)`.
2. **Ref-key gaps (cosmetic; renumbered):** missing `ref18`, `ref24`, `ref25` in the previous key sequence; bibliography reindexed to contiguous keys.
3. **`\begin{thebibliography}{27}` under-counted** entries (27 labels vs wider width); set to match entry count.
4. **All body citations resolve** after the Robertson label fix. Product/meeting refs (Zoom, Otter, Fireflies, AMI/QMSum/MeetingBank/MeetBench) remain cited in Related Work.
5. **Yang et al. (2025)** retained for Qwen3 (replacing the prior “Qwen Team” attribution).

## Open (optional polish)
- Expand truncated author lists (`et al.`) for Bai/Yang/Tu/Zakka if camera-ready requires full lists.
- Cross-check every URL access date before camera-ready.
