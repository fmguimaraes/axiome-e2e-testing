/**
 * AXI-2663 (epic AXI-2630, FR73, FR74, AC54, AC55; SI-042). PURE data: the values a MAG4
 * reproduction must reach, cited from section 20 of BACKLOG-Investigator-On-Shared-Principles and,
 * for the 42 heatmap cells, from demo/mag4-microbiote/data/targets.json. Nothing here is computed.
 *
 * Owner ruling 2026-11-18: a value equals its section 20 Platform value at the precision section 20
 * prints it (never more than 4 decimals) AND rounds to its Reference value. No other tolerance
 * exists. The one allowed residual is IgG4-RD RI x MAG4-22.
 */
export interface PublishedValue {
  platform: { value: number; decimals: number };
  /** Absent when section 20 prints no separate Reference value for it. */
  reference?: { value: number; decimals: number };
}

export const ALPHA = 0.05;

export const OPERATIONS = {
  dunn: 'stats.dunn_posthoc',
  kruskal: 'stats.kruskal_wallis',
  mannWhitney: 'stats.mann_whitney_u',
  matrix: 'stats.correlation_matrix',
} as const;

const published = (value: number, decimals: number, reference?: number): PublishedValue => ({
  platform: { value, decimals },
  ...(reference === undefined ? {} : { reference: { value: reference, decimals: 3 } }),
});

export const IMAGE_1 = {
  groupNs: { HD: 10, 'IgG4-RD': 26, SD: 10 } as Record<string, number>,
  adjustmentMethod: 'holm',
  significant: [
    { stratum: 'ENT 059', adjustedP: published(0.0217, 4, 0.022) },
    { stratum: 'CER 229', adjustedP: published(0.0378, 4, 0.038) },
  ],
  notSignificant: {
    stratum: 'CER 215 et 234',
    vsHD: published(0.437, 3),
    vsSD: published(0.325, 3),
  },
} as const;

export const IMAGE_2 = { n: 23, groups: 4, h: published(4.871, 3), p: published(0.1815, 4, 0.182) } as const;

/** n and U are pinned together: groupFrom is Absent (9), groupTo is Present (14), U is Present's. */
export const IMAGE_3 = { nFrom: 9, nTo: 14, u: published(77.5, 1), p: published(0.3705, 4, 0.371) } as const;

export const IMAGE_4 = { method: 'spearman', familyScope: 'per_reference', cells: 42, stars: 15 } as const;

export interface HeatmapCell {
  referenceLabel: string;
  reference: string;
  variableLabel: string;
  variable: string;
  rho: number;
  star: boolean;
}

type CellRow = [string, string, string, string, number, boolean];

const CELL_ROWS: readonly CellRow[] = [
  ['CER228', 'microbiote_igg4_cer_228', 'sIgG4', 'igg4_g_l', 0.59, true],
  ['CER228', 'microbiote_igg4_cer_228', 'IgG4-RD RI', 'igg4_rd_ri', 0.58, true],
  ['CER228', 'microbiote_igg4_cer_228', 'IgG4+/HPF', 'igg4_hpf', 0.53, true],
  ['CER228', 'microbiote_igg4_cer_228', 'Eosinophils', 'eosinophils', 0.23, false],
  ['CER228', 'microbiote_igg4_cer_228', 'Plasmablasts', 'plasmablasts_cd19_cd38_cd27_mm3', 0.17, false],
  ['CER228', 'microbiote_igg4_cer_228', 'TFH', 'tfh_cxcr5_pd1_cd4', 0.33, false],
  ['MAG4-27', 'microbiote_igg4_mag4_27', 'sIgG4', 'igg4_g_l', 0.32, false],
  ['MAG4-27', 'microbiote_igg4_mag4_27', 'IgG4-RD RI', 'igg4_rd_ri', 0.42, false],
  ['MAG4-27', 'microbiote_igg4_mag4_27', 'IgG4+/HPF', 'igg4_hpf', 0.66, true],
  ['MAG4-27', 'microbiote_igg4_mag4_27', 'Eosinophils', 'eosinophils', 0.21, false],
  ['MAG4-27', 'microbiote_igg4_mag4_27', 'Plasmablasts', 'plasmablasts_cd19_cd38_cd27_mm3', 0.17, false],
  ['MAG4-27', 'microbiote_igg4_mag4_27', 'TFH', 'tfh_cxcr5_pd1_cd4', 0.24, false],
  ['MAG4-22', 'microbiote_igg4_mag4_22', 'sIgG4', 'igg4_g_l', 0.68, true],
  ['MAG4-22', 'microbiote_igg4_mag4_22', 'IgG4-RD RI', 'igg4_rd_ri', 0.50, false],
  ['MAG4-22', 'microbiote_igg4_mag4_22', 'IgG4+/HPF', 'igg4_hpf', 0.25, false],
  ['MAG4-22', 'microbiote_igg4_mag4_22', 'Eosinophils', 'eosinophils', 0.35, false],
  ['MAG4-22', 'microbiote_igg4_mag4_22', 'Plasmablasts', 'plasmablasts_cd19_cd38_cd27_mm3', 0.23, false],
  ['MAG4-22', 'microbiote_igg4_mag4_22', 'TFH', 'tfh_cxcr5_pd1_cd4', 0.28, false],
  ['MAG4-13', 'microbiote_igg4_mag4_13', 'sIgG4', 'igg4_g_l', 0.36, false],
  ['MAG4-13', 'microbiote_igg4_mag4_13', 'IgG4-RD RI', 'igg4_rd_ri', 0.38, false],
  ['MAG4-13', 'microbiote_igg4_mag4_13', 'IgG4+/HPF', 'igg4_hpf', 0.47, false],
  ['MAG4-13', 'microbiote_igg4_mag4_13', 'Eosinophils', 'eosinophils', 0.29, false],
  ['MAG4-13', 'microbiote_igg4_mag4_13', 'Plasmablasts', 'plasmablasts_cd19_cd38_cd27_mm3', 0.25, false],
  ['MAG4-13', 'microbiote_igg4_mag4_13', 'TFH', 'tfh_cxcr5_pd1_cd4', 0.41, false],
  ['CER215+234', 'microbiote_igg4_cer_215_et_234', 'sIgG4', 'igg4_g_l', 0.80, true],
  ['CER215+234', 'microbiote_igg4_cer_215_et_234', 'IgG4-RD RI', 'igg4_rd_ri', 0.61, true],
  ['CER215+234', 'microbiote_igg4_cer_215_et_234', 'IgG4+/HPF', 'igg4_hpf', 0.30, false],
  ['CER215+234', 'microbiote_igg4_cer_215_et_234', 'Eosinophils', 'eosinophils', 0.56, true],
  ['CER215+234', 'microbiote_igg4_cer_215_et_234', 'Plasmablasts', 'plasmablasts_cd19_cd38_cd27_mm3', 0.45, false],
  ['CER215+234', 'microbiote_igg4_cer_215_et_234', 'TFH', 'tfh_cxcr5_pd1_cd4', 0.49, true],
  ['CER229', 'microbiote_igg4_cer_229', 'sIgG4', 'igg4_g_l', 0.63, true],
  ['CER229', 'microbiote_igg4_cer_229', 'IgG4-RD RI', 'igg4_rd_ri', 0.63, true],
  ['CER229', 'microbiote_igg4_cer_229', 'IgG4+/HPF', 'igg4_hpf', 0.37, false],
  ['CER229', 'microbiote_igg4_cer_229', 'Eosinophils', 'eosinophils', 0.34, false],
  ['CER229', 'microbiote_igg4_cer_229', 'Plasmablasts', 'plasmablasts_cd19_cd38_cd27_mm3', 0.25, false],
  ['CER229', 'microbiote_igg4_cer_229', 'TFH', 'tfh_cxcr5_pd1_cd4', 0.10, false],
  ['ENT059', 'microbiote_igg4_ent_059', 'sIgG4', 'igg4_g_l', 0.78, true],
  ['ENT059', 'microbiote_igg4_ent_059', 'IgG4-RD RI', 'igg4_rd_ri', 0.53, true],
  ['ENT059', 'microbiote_igg4_ent_059', 'IgG4+/HPF', 'igg4_hpf', 0.34, false],
  ['ENT059', 'microbiote_igg4_ent_059', 'Eosinophils', 'eosinophils', 0.55, true],
  ['ENT059', 'microbiote_igg4_ent_059', 'Plasmablasts', 'plasmablasts_cd19_cd38_cd27_mm3', 0.55, true],
  ['ENT059', 'microbiote_igg4_ent_059', 'TFH', 'tfh_cxcr5_pd1_cd4', 0.43, false],
];

export const HEATMAP_CELLS: readonly HeatmapCell[] = CELL_ROWS.map(
  ([referenceLabel, reference, variableLabel, variable, rho, star]) => ({
    referenceLabel, reference, variableLabel, variable, rho, star,
  }),
);

/** Section 20, known residuals: the ONLY value allowed to differ, and only to exactly this. */
export const KNOWN_RESIDUAL = {
  reference: 'microbiote_igg4_mag4_22',
  variable: 'igg4_rd_ri',
  slideRho: 0.5,
  acceptedRho: 0.49,
} as const;
