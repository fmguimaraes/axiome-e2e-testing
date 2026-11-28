# AXI-2802 — screenshots of the merged interfaces (2026-11-28)

Demo stack (`localhost:5173`, main at front `70c1dc57`), workspace "Mag4", signed in as admin@cro-one.com.
The two projects shown were created for the capture and deleted afterwards.

| File | Story | Shows |
|---|---|---|
| `01-create-picker-collapsed.png` | AXI-2809 (A7) | Project creation: one profile picked; the picker is the pre-A7 dropdown plus "+ Combine with another scientific context" |
| `02-create-picker-expanded.png` | AXI-2809 (A7) | The picker expanded into a checklist ("Up to 5 profiles may be combined", "Use a single profile") |
| `03-create-refused-combination.png` | AXI-2806 (A4) + AXI-2809 (A7) | Immunology + Oncology refused on save: every issue listed (AC40), no project created |
| `04-settings-combined-project.png` | AXI-2809 (A7) | Project Settings of a two-profile project |
| `05-tab-single-profile.png` | AXI-2809 (A7) | Semantic Profile tab of a single-profile project: unchanged (no composite header) |
| `06-tab-combined-profiles.png` | AXI-2806 (A4) + AXI-2809 (A7) | Semantic Profile tab of a two-profile project: composite name, members and the merged vocabulary |

Gaps seen in these captures:
- The project header chip (06) shows only the first profile ("Immune-Mediated"); FR47 asks every display of the project's profile to show all selected names.
- The "Composed of" line (06) lists raw profile keys, not display names (advisory from the AXI-2809 review).

Not captured: AXI-2808 (A6) changed no visible surface (non-regression refactor); AXI-2803/2804/2805/2807 are back end only.
The CRUD page (AXI-2810, A8) is still in development.
