# AXI-2319 (epic AXI-2309, FR31/AC12, SI-042 + SI-053) — the INDEPENDENT R
# reference for Paul Dalmas's methods, computed on the exact prod-suite fixture
# bytes the daily suite runs on.
#
# Reads every probe from paul-probes.json (the ONE declaration the TypeScript
# executor also reads), applies the probe's filters to its fixture, and computes
# each checked field with the R function the bio-compute method-validation
# programme already pins for that operation (AXI-2067/AXI-2068 parity fixtures,
# reference_arguments verbatim):
#   stats.kruskal_wallis     stats::kruskal.test
#   stats.mann_whitney_u     stats::wilcox.test(to, from, paired = FALSE, correct = TRUE),
#                            exact per the platform's rule (see mann_whitney below)
#   stats.correlation        stats::cor.test(method = "spearman", exact = FALSE)
#   stats.dunn_posthoc       FSA::dunnTest(method = "holm") for Z and the unadjusted p;
#                            stats::p.adjust(method = "holm") over the 3-pair family
#                            for the adjusted p (FR9 amended, D7.1, AXI-2096)
#   stats.partial_correlation ppcor::pcor.test(method = "spearman")
# Missing values: each probe drops only the rows missing one of ITS columns.
#
# Never run by hand into the committed JSON: scripts/prod-suite-r-reference.ts
# runs this file in the pinned R image and stamps the hashes. Output: JSON on stdout.

suppressPackageStartupMessages({
  library(jsonlite)
  library(FSA)
  library(ppcor)
})

args <- commandArgs(trailingOnly = TRUE)
probes_file <- args[[1]]
fixtures_dir <- args[[2]]

FIXTURE_FILES <- c(
  tableau1 = "final_tableau1_long_synthetic.csv",
  tableau2 = "final_tableau2_synthetic.csv"
)

read_fixture <- function(key) {
  read.csv(file.path(fixtures_dir, FIXTURE_FILES[[key]]), stringsAsFactors = FALSE,
           na.strings = c("", "NA"), check.names = FALSE, colClasses = "character")
}

apply_filter <- function(df, f) {
  col <- df[[f$column]]
  if (f$operator == "in") return(df[col %in% unlist(f$value), , drop = FALSE])
  if (f$operator == "eq") return(df[!is.na(col) & col == f$value, , drop = FALSE])
  stop(sprintf("unsupported filter operator %s", f$operator))
}

probe_frame <- function(probe) {
  df <- read_fixture(probe$fixture)
  for (f in probe$filters) df <- apply_filter(df, f)
  df
}

num <- function(x) as.numeric(x)

complete <- function(df, cols) df[stats::complete.cases(df[, cols, drop = FALSE]), , drop = FALSE]

kruskal <- function(df, probe) {
  g <- probe$roleBindings$groupColumn; v <- probe$pivot$valueColumn
  d <- complete(df, c(g, v))
  r <- stats::kruskal.test(num(d[[v]]), factor(d[[g]]))
  list(list(row = setNames(list(), character(0)), values = list(hStatistic = unname(r$statistic), pValue = r$p.value)))
}

mann_whitney <- function(df, probe) {
  g <- probe$roleBindings$groupColumn; v <- probe$pivot$valueColumn
  d <- complete(df, c(g, v))
  p <- probe$operationParams
  from <- num(d[[v]][d[[g]] == p$groupFrom]); to <- num(d[[v]][d[[g]] == p$groupTo])
  # The validated orientation (bio-compute r_mwu): U is the groupTo sample's
  # statistic, wilcox.test(to, from). Exactness mirrors the platform (scipy
  # method='auto'): exact iff NOT both arms > 8 and no ties in the pooled sample.
  exact <- !(length(from) > 8 && length(to) > 8) && !anyDuplicated(c(from, to))
  r <- suppressWarnings(stats::wilcox.test(to, from, paired = FALSE, alternative = "two.sided", exact = exact, correct = TRUE))
  list(list(row = setNames(list(), character(0)), values = list(uStatistic = unname(r$statistic), pValue = r$p.value)))
}

spearman <- function(df, probe) {
  x <- probe$roleBindings$xColumn; y <- probe$roleBindings$yColumn
  d <- complete(df, c(x, y))
  r <- stats::cor.test(num(d[[x]]), num(d[[y]]), method = "spearman", exact = FALSE)
  list(list(row = setNames(list(), character(0)), values = list(coefficient = unname(r$estimate), pValue = r$p.value)))
}

partial_spearman <- function(df, probe) {
  x <- probe$roleBindings$xColumn; y <- probe$roleBindings$yColumn
  z <- unlist(probe$roleBindings$covariateColumns)
  d <- complete(df, c(x, y, z))
  r <- ppcor::pcor.test(num(d[[x]]), num(d[[y]]), as.data.frame(lapply(d[, z, drop = FALSE], num)), method = "spearman")
  list(list(row = setNames(list(), character(0)), values = list(coefficient = r$estimate, pValue = r$p.value)))
}

dunn_row <- function(res, a, b) {
  hit <- which(res$Comparison == paste(a, "-", b))
  if (length(hit) == 1) return(list(z = res$Z[[hit]], p = res$P.unadj[[hit]]))
  hit <- which(res$Comparison == paste(b, "-", a))
  if (length(hit) == 1) return(list(z = -res$Z[[hit]], p = res$P.unadj[[hit]]))
  stop(sprintf("FSA::dunnTest has no comparison for %s / %s", a, b))
}

dunn <- function(df, probe) {
  g <- probe$roleBindings$groupColumn; v <- probe$pivot$valueColumn
  d <- complete(df, c(g, v))
  res <- FSA::dunnTest(num(d[[v]]), factor(d[[g]]), method = "holm")$res
  levels <- sort(unique(d[[g]]))
  pairs <- utils::combn(levels, 2, simplify = FALSE)
  raw <- lapply(pairs, function(p) dunn_row(res, p[[1]], p[[2]]))
  adjusted <- stats::p.adjust(vapply(raw, function(r) r$p, numeric(1)), method = "holm")
  lapply(seq_along(pairs), function(i) list(
    row = list(groupA = pairs[[i]][[1]], groupB = pairs[[i]][[2]]),
    values = list(zStatistic = raw[[i]]$z, pValue = raw[[i]]$p, adjustedPValue = adjusted[[i]])
  ))
}

COMPUTE <- list(
  "stats.kruskal_wallis" = kruskal,
  "stats.mann_whitney_u" = mann_whitney,
  "stats.correlation" = spearman,
  "stats.partial_correlation" = partial_spearman,
  "stats.dunn_posthoc" = dunn
)

declared <- fromJSON(probes_file, simplifyVector = FALSE)
out <- lapply(declared$probes, function(probe) {
  df <- probe_frame(probe)
  list(id = probe$id, operationId = probe$operationId, n = nrow(df), rows = COMPUTE[[probe$operationId]](df, probe))
})

meta <- list(
  rVersion = R.version.string,
  packages = list(
    stats = as.character(packageVersion("stats")),
    FSA = as.character(packageVersion("FSA")),
    ppcor = as.character(packageVersion("ppcor"))
  )
)
cat(toJSON(list(meta = meta, probes = out), auto_unbox = TRUE, digits = NA, pretty = TRUE, null = "null"))
cat("\n")
