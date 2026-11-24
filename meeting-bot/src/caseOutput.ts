import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Express } from "express";
import { chromium, type Browser } from "playwright";
import type { CaseRevision, CaseWorkspace } from "./caseWorkspace.js";
import type { RetrievalRecord } from "./retrieval.js";

export type CaseOutputStatus =
  | "queued"
  | "processing"
  | "complete"
  | "partial"
  | "failed";

export type CaseOutputFormat = "json" | "html" | "pdf";

export type CaseOutputArtifact = {
  format: CaseOutputFormat;
  status: "ready" | "failed";
  mimeType: string;
  fileName: string;
  sizeBytes?: number;
  sha256?: string;
  error?: string;
};

export type CaseOutputRecord = {
  schemaVersion: 1;
  outputId: string;
  outputVersion: number;
  caseId: string;
  revisionId: string;
  retrievalIds: string[];
  templateVersion: "echo-clinical-v1";
  language: "en";
  status: CaseOutputStatus;
  artifacts: CaseOutputArtifact[];
  warnings: string[];
  retryable: boolean;
  idempotencyKey: string;
  createdAt: string;
  completedAt?: string;
};

export type CaseOutputConfig = {
  enabled: boolean;
  available: boolean;
  unavailableReasons: string[];
  caseDataDir: string;
  formats: CaseOutputFormat[];
  templateVersion: "echo-clinical-v1";
  language: "en";
  pdfTimeoutMs: number;
  maxConcurrent: number;
};

export type CaseOutputEventEmitter = (type: string, payload?: unknown) => void;

export type CaseOutputCaseProvider = {
  get(caseId: string): Promise<{
    workspace: CaseWorkspace;
    currentRevision: CaseRevision | null;
  } | null>;
  revision(caseId: string, revisionId: string): Promise<CaseRevision | null>;
};

export type CaseOutputRetrievalProvider = {
  recordsForCase(caseId: string): Promise<RetrievalRecord[]>;
};

export type CaseOutputPdfRenderer = {
  render(
    html: string,
    options: { caseId: string; outputId: string; timeoutMs: number },
  ): Promise<Buffer>;
  health(): Promise<{
    configured: boolean;
    available: boolean;
    launched: boolean;
    executablePath: string;
    error?: string;
  }>;
  shutdown(): Promise<void>;
};

type SourceRef =
  | { type: "transcript"; segmentId: number; timestamp: number }
  | { type: "screen-frame"; frameId: number; timestamp: number };

type CaseFact = CaseRevision["caseOverview"][number];
type Recommendation = CaseRevision["recommendations"][number];
type FollowUp = CaseRevision["followUpActions"][number];

export type CaseOutputEvidenceSnapshot = {
  retrievalId: string;
  status: "complete" | "partial";
  createdAt: string;
  completedAt?: string;
  historicalCases: RetrievalRecord["historicalCases"];
  literature: RetrievalRecord["literature"];
  warnings: string[];
};

export type CaseOutputPacket = {
  schemaVersion: 1;
  output: {
    outputId: string;
    outputVersion: number;
    templateVersion: "echo-clinical-v1";
    language: "en";
    createdAt: string;
  };
  case: {
    caseId: string;
    revisionId: string;
    revisionGeneratedAt: string;
    meetingStartedAt: string | null;
    meetingEndedAt: string | null;
    caseDetected: boolean;
    detectionConfidence: CaseRevision["detectionConfidence"];
    caseDiscussionRange: CaseRevision["caseDiscussionRange"];
  };
  disclaimer: string;
  caseOverview: CaseFact[];
  presentingQuestions: CaseFact[];
  patientContext: CaseFact[];
  historyAndConditions: CaseFact[];
  medicationsAndTreatments: CaseFact[];
  testsAndFindings: CaseFact[];
  discussionThreads: CaseFact[];
  recommendations: Recommendation[];
  rejectedOrRevisedSuggestions: CaseFact[];
  disagreements: CaseFact[];
  unresolvedQuestionsAndDataGaps: CaseFact[];
  followUpActions: FollowUp[];
  deidentificationWarnings: CaseFact[];
  generationWarnings: string[];
  evidence: CaseOutputEvidenceSnapshot[];
  provenance: {
    revisionId: string;
    retrievalIds: string[];
    sourcePolicy: string;
  };
};

type QueueItem = {
  outputId: string;
  retry: boolean;
};

const DISCLAIMER =
  "AI-generated ECHO internal educational summary; not a medical record or clinical advice.";
const NOT_DOCUMENTED = "Not documented in source material";
const execFileAsync = promisify(execFile);

const FORMAT_METADATA: Record<
  CaseOutputFormat,
  { mimeType: string; storageName: string }
> = {
  json: { mimeType: "application/json", storageName: "case-output.json" },
  html: { mimeType: "text/html; charset=utf-8", storageName: "report.html" },
  pdf: { mimeType: "application/pdf", storageName: "report.pdf" },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizePathPart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe || "unknown";
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function atomicWrite(filePath: string, value: Buffer | string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, filePath);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

function safeUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function formatTimestamp(value: number): string {
  if (Number.isFinite(value) && value > 100_000_000_000) {
    return new Date(value).toISOString();
  }
  return `${value} ms`;
}

function sourceLabel(ref: SourceRef): string {
  return ref.type === "transcript"
    ? `T-${ref.segmentId} (${formatTimestamp(ref.timestamp)})`
    : `S-${ref.frameId} (${formatTimestamp(ref.timestamp)})`;
}

function sourceRefsHtml(sourceRefs: SourceRef[]): string {
  return sourceRefs
    .map((ref) => `<span class="source">${escapeHtml(sourceLabel(ref))}</span>`)
    .join(" ");
}

function confidenceBadge(confidence: string): string {
  return `<span class="confidence confidence-${escapeHtml(confidence)}">${escapeHtml(
    confidence,
  )}</span>`;
}

function factsHtml(facts: CaseFact[]): string {
  if (facts.length === 0) {
    return `<p class="empty">${NOT_DOCUMENTED}</p>`;
  }
  return `<ul class="facts">${facts
    .map(
      (fact) =>
        `<li class="${fact.confidence === "low" ? "low-confidence" : ""}">
          <div>${escapeHtml(fact.text)} ${confidenceBadge(fact.confidence)}</div>
          <div class="sources">${sourceRefsHtml(fact.sourceRefs)}</div>
        </li>`,
    )
    .join("")}</ul>`;
}

function evidenceFactsHtml(
  facts: Array<{ text: string; sourceRefs: SourceRef[] }>,
): string {
  if (facts.length === 0) {
    return `<p class="empty">${NOT_DOCUMENTED}</p>`;
  }
  return `<ul class="facts">${facts
    .map(
      (fact) =>
        `<li><div>${escapeHtml(fact.text)}</div><div class="sources">${sourceRefsHtml(
          fact.sourceRefs,
        )}</div></li>`,
    )
    .join("")}</ul>`;
}

function section(title: string, content: string): string {
  return `<section><h2>${escapeHtml(title)}</h2>${content}</section>`;
}

function recommendationTable(recommendations: Recommendation[]): string {
  if (recommendations.length === 0) {
    return `<p class="empty">${NOT_DOCUMENTED}</p>`;
  }
  return `<table>
    <thead><tr><th>Recommendation</th><th>Rationale</th><th>Proposer</th><th>Consensus</th><th>Confidence</th><th>Sources</th></tr></thead>
    <tbody>${recommendations
      .map(
        (item) => `<tr class="${item.confidence === "low" ? "low-confidence" : ""}">
          <td>${escapeHtml(item.text)}</td>
          <td>${escapeHtml(item.rationale || NOT_DOCUMENTED)}</td>
          <td>${escapeHtml(item.proposer || NOT_DOCUMENTED)}</td>
          <td>${escapeHtml(item.consensusStatus)}</td>
          <td>${confidenceBadge(item.confidence)}</td>
          <td>${sourceRefsHtml(item.sourceRefs)}</td>
        </tr>`,
      )
      .join("")}</tbody>
  </table>`;
}

function followUpTable(actions: FollowUp[]): string {
  if (actions.length === 0) {
    return `<p class="empty">${NOT_DOCUMENTED}</p>`;
  }
  return `<table>
    <thead><tr><th>Action</th><th>Responsible party</th><th>Timing</th><th>Confidence</th><th>Sources</th></tr></thead>
    <tbody>${actions
      .map(
        (item) => `<tr class="${item.confidence === "low" ? "low-confidence" : ""}">
          <td>${escapeHtml(item.text)}</td>
          <td>${escapeHtml(item.responsibleParty || NOT_DOCUMENTED)}</td>
          <td>${escapeHtml(item.timing || NOT_DOCUMENTED)}</td>
          <td>${confidenceBadge(item.confidence)}</td>
          <td>${sourceRefsHtml(item.sourceRefs)}</td>
        </tr>`,
      )
      .join("")}</tbody>
  </table>`;
}

function historicalEvidenceHtml(evidence: CaseOutputEvidenceSnapshot[]): string {
  const hits = evidence.flatMap((snapshot) =>
    snapshot.historicalCases.map((hit) => ({ snapshot, hit })),
  );
  if (hits.length === 0) {
    return `<p class="empty">${NOT_DOCUMENTED}</p>`;
  }
  return `<div class="evidence-list">${hits
    .map(
      ({ snapshot, hit }) => `<article class="evidence-item">
        <h3>[Case:${escapeHtml(hit.caseId)}]</h3>
        <p><strong>Revision:</strong> ${escapeHtml(hit.revisionId)} · <strong>Similarity:</strong> ${escapeHtml(hit.similarityScore)}</p>
        <p><strong>Similarities:</strong> ${escapeHtml(hit.similarities.join("; ") || NOT_DOCUMENTED)}</p>
        <p><strong>Key differences:</strong> ${escapeHtml(hit.keyDifferences.join("; ") || NOT_DOCUMENTED)}</p>
        <p><strong>Relevant recommendations:</strong></p>
        ${evidenceFactsHtml(hit.relevantRecommendations)}
        <p><strong>Relevant outcomes:</strong></p>
        ${evidenceFactsHtml(hit.relevantOutcomes)}
        <p class="provenance">Retrieval ${escapeHtml(snapshot.retrievalId)}</p>
      </article>`,
    )
    .join("")}</div>`;
}

function linkHtml(label: string, value: string | null | undefined): string {
  const url = safeUrl(value);
  return url
    ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`
    : "";
}

function literatureEvidenceHtml(evidence: CaseOutputEvidenceSnapshot[]): string {
  const hits = evidence.flatMap((snapshot) =>
    snapshot.literature.map((hit) => ({ snapshot, hit })),
  );
  if (hits.length === 0) {
    return `<p class="empty">${NOT_DOCUMENTED}</p>`;
  }
  return `<div class="evidence-list">${hits
    .map(
      ({ snapshot, hit }) => `<article class="evidence-item">
        <h3>[PMID:${escapeHtml(hit.pmid)}] ${escapeHtml(hit.title)}</h3>
        <p>${escapeHtml(hit.authors.join(", ") || NOT_DOCUMENTED)}</p>
        <p>${escapeHtml(hit.journal || NOT_DOCUMENTED)} · ${escapeHtml(hit.publicationDate || NOT_DOCUMENTED)}</p>
        <p><strong>Publication type:</strong> ${escapeHtml(hit.publicationTypes.join(", ") || NOT_DOCUMENTED)}</p>
        <p><strong>Relevance:</strong> ${escapeHtml(hit.relevanceReason)}</p>
        <p><strong>Abstract-supported conclusion:</strong> ${escapeHtml(hit.abstractSupportedConclusion || NOT_DOCUMENTED)}</p>
        <p class="links">
          ${linkHtml("PubMed", hit.pubmedUrl)}
          ${linkHtml("DOI", hit.doiUrl)}
          ${linkHtml("PMC", hit.pmcUrl)}
        </p>
        <p class="provenance">Retrieval ${escapeHtml(snapshot.retrievalId)}</p>
      </article>`,
    )
    .join("")}</div>`;
}

export function buildCaseOutputPacket(
  record: CaseOutputRecord,
  workspace: CaseWorkspace,
  revision: CaseRevision,
  retrievals: RetrievalRecord[],
): CaseOutputPacket {
  return {
    schemaVersion: 1,
    output: {
      outputId: record.outputId,
      outputVersion: record.outputVersion,
      templateVersion: record.templateVersion,
      language: record.language,
      createdAt: record.createdAt,
    },
    case: {
      caseId: record.caseId,
      revisionId: record.revisionId,
      revisionGeneratedAt: revision.generatedAt,
      meetingStartedAt: workspace.meetingStartedAt,
      meetingEndedAt: workspace.meetingEndedAt,
      caseDetected: revision.caseDetected,
      detectionConfidence: revision.detectionConfidence,
      caseDiscussionRange: revision.caseDiscussionRange,
    },
    disclaimer: DISCLAIMER,
    caseOverview: revision.caseOverview,
    presentingQuestions: revision.presentingQuestions,
    patientContext: revision.patientContext,
    historyAndConditions: revision.historyAndConditions,
    medicationsAndTreatments: revision.medicationsAndTreatments,
    testsAndFindings: revision.testsAndFindings,
    discussionThreads: revision.discussionThreads,
    recommendations: revision.recommendations,
    rejectedOrRevisedSuggestions: revision.rejectedOrRevisedSuggestions,
    disagreements: revision.disagreements,
    unresolvedQuestionsAndDataGaps: revision.unresolvedQuestionsAndDataGaps,
    followUpActions: revision.followUpActions,
    deidentificationWarnings: revision.deidentificationWarnings,
    generationWarnings: revision.generationWarnings,
    evidence: retrievals.map((retrieval) => ({
      retrievalId: retrieval.retrievalId,
      status: retrieval.status as "complete" | "partial",
      createdAt: retrieval.createdAt,
      ...(retrieval.completedAt ? { completedAt: retrieval.completedAt } : {}),
      historicalCases: retrieval.historicalCases,
      literature: retrieval.literature,
      warnings: retrieval.warnings,
    })),
    provenance: {
      revisionId: revision.revisionId,
      retrievalIds: retrievals.map((retrieval) => retrieval.retrievalId),
      sourcePolicy:
        "Clinical facts are copied verbatim from the immutable case revision and retain their original field-level source references.",
    },
  };
}

export function renderCaseOutputHtml(packet: CaseOutputPacket): string {
  const warnings = [
    ...packet.generationWarnings,
    ...packet.evidence.flatMap((item) => item.warnings),
  ];
  const phiWarning = packet.deidentificationWarnings.length
    ? `<div class="alert alert-phi"><strong>Potential de-identification risk:</strong> This report contains ${packet.deidentificationWarnings.length} warning(s). Review before sharing outside the ECHO team.</div>`
    : "";
  const noCase = !packet.case.caseDetected
    ? `<div class="alert"><strong>No case presentation detected.</strong> The source revision did not identify a sufficiently grounded patient case.</div>`
    : "";
  const warningContent =
    warnings.length || packet.deidentificationWarnings.length
      ? `${factsHtml(packet.deidentificationWarnings)}
         ${warnings.length ? `<ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : ""}`
      : `<p class="empty">${NOT_DOCUMENTED}</p>`;
  const clinicalSections = packet.case.caseDetected
    ? `
  ${section("Case overview", factsHtml(packet.caseOverview))}
  ${section("Presenting questions", factsHtml(packet.presentingQuestions))}
  ${section("Patient context", factsHtml(packet.patientContext))}
  ${section("History and comorbidities", factsHtml(packet.historyAndConditions))}
  ${section("Medications and treatments", factsHtml(packet.medicationsAndTreatments))}
  ${section("Tests and findings", factsHtml(packet.testsAndFindings))}
  ${section("Discussion threads", factsHtml(packet.discussionThreads))}
  ${section("Recommendations", recommendationTable(packet.recommendations))}
  ${section("Rejected or revised suggestions", factsHtml(packet.rejectedOrRevisedSuggestions))}
  ${section("Expert disagreements", factsHtml(packet.disagreements))}
  ${section("Unresolved questions and data gaps", factsHtml(packet.unresolvedQuestionsAndDataGaps))}
  ${section("Follow-up actions", followUpTable(packet.followUpActions))}
  ${section("Historical ECHO case evidence", historicalEvidenceHtml(packet.evidence))}
  ${section("PubMed evidence", literatureEvidenceHtml(packet.evidence))}`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ECHO Case Report ${escapeHtml(packet.case.caseId)}</title>
  <style>
    :root { color-scheme: light; font-family: Arial, Helvetica, sans-serif; color: #172033; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f7fb; font-size: 12px; line-height: 1.45; }
    main { max-width: 920px; margin: 0 auto; background: white; padding: 34px 42px; }
    h1 { margin: 0 0 6px; color: #173f70; font-size: 26px; }
    h2 { color: #173f70; font-size: 17px; border-bottom: 2px solid #dbe6f3; padding-bottom: 5px; margin-top: 24px; }
    h3 { color: #274d79; font-size: 13px; margin-bottom: 5px; }
    p { margin: 5px 0; }
    .meta { color: #4b5565; display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; margin: 12px 0; }
    .disclaimer, .alert { padding: 10px 12px; border-left: 4px solid #d48b11; background: #fff6df; margin: 14px 0; }
    .alert-phi { border-color: #bd2f2f; background: #fff0f0; color: #761d1d; }
    .facts { padding-left: 20px; }
    .facts li { margin: 7px 0; break-inside: avoid; }
    .sources { margin-top: 3px; }
    .source { display: inline-block; background: #edf3fa; color: #294d75; border-radius: 3px; padding: 1px 4px; margin: 1px; font-size: 10px; }
    .confidence { text-transform: uppercase; border-radius: 8px; padding: 1px 5px; font-size: 9px; font-weight: bold; }
    .confidence-high { background: #e4f4e9; color: #176634; }
    .confidence-medium { background: #fff2cf; color: #775400; }
    .confidence-low { background: #fde2e2; color: #922828; }
    .low-confidence { border-left: 3px solid #d85656; padding-left: 7px; }
    .empty { color: #6c7480; font-style: italic; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 10px; }
    th, td { border: 1px solid #ccd7e4; padding: 6px; vertical-align: top; overflow-wrap: anywhere; }
    th { background: #eaf1f8; color: #173f70; text-align: left; }
    tr { break-inside: avoid; }
    .evidence-item { border: 1px solid #d6deea; border-radius: 4px; padding: 10px; margin: 8px 0; break-inside: avoid; }
    .links a { margin-right: 12px; color: #145da0; }
    .provenance { color: #6b7280; font-size: 10px; }
    .footer-note { margin-top: 28px; color: #6b7280; font-size: 10px; }
    @media print {
      body { background: white; }
      main { max-width: none; padding: 0; }
      a { color: #145da0; text-decoration: underline; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <h1>ECHO Structured Case Report</h1>
    <div class="meta">
      <div><strong>Case ID:</strong> ${escapeHtml(packet.case.caseId)}</div>
      <div><strong>Output version:</strong> ${escapeHtml(packet.output.outputVersion)}</div>
      <div><strong>Revision ID:</strong> ${escapeHtml(packet.case.revisionId)}</div>
      <div><strong>Output ID:</strong> ${escapeHtml(packet.output.outputId)}</div>
      <div><strong>Meeting started:</strong> ${escapeHtml(packet.case.meetingStartedAt || NOT_DOCUMENTED)}</div>
      <div><strong>Meeting ended:</strong> ${escapeHtml(packet.case.meetingEndedAt || NOT_DOCUMENTED)}</div>
    </div>
    <div class="disclaimer"><strong>${escapeHtml(packet.disclaimer)}</strong></div>
    ${phiWarning}
    ${noCase}
  </header>
  ${clinicalSections}
  ${section("Warnings", warningContent)}
  ${section(
    "Provenance",
    `<p><strong>Revision:</strong> ${escapeHtml(packet.provenance.revisionId)}</p>
     <p><strong>Retrieval records:</strong> ${escapeHtml(packet.provenance.retrievalIds.join(", ") || NOT_DOCUMENTED)}</p>
     <p>${escapeHtml(packet.provenance.sourcePolicy)}</p>`,
  )}
  <p class="footer-note">Template ${escapeHtml(packet.output.templateVersion)} · Generated ${escapeHtml(packet.output.createdAt)}</p>
</main>
</body>
</html>`;
}

class PlaywrightCaseOutputPdfRenderer implements CaseOutputPdfRenderer {
  private browser: Browser | null = null;
  private lastError: string | null = null;
  private readonly executablePath = chromium.executablePath();

  async render(
    html: string,
    options: { caseId: string; outputId: string; timeoutMs: number },
  ): Promise<Buffer> {
    let page: Awaited<ReturnType<Browser["newPage"]>> | null = null;
    try {
      if (!this.browser?.isConnected()) {
        this.browser = await chromium.launch({ headless: true });
      }
      page = await this.browser.newPage();
      await page.route("**/*", (route) => route.abort());
      page.setDefaultTimeout(options.timeoutMs);
      await page.setContent(html, { waitUntil: "load", timeout: options.timeoutMs });
      const pdfPromise = page.pdf({
        format: "Letter",
        printBackground: true,
        margin: {
          top: "0.6in",
          right: "0.55in",
          bottom: "0.7in",
          left: "0.55in",
        },
        displayHeaderFooter: true,
        headerTemplate: "<span></span>",
        footerTemplate: `<div style="font-size:8px;color:#687386;width:100%;padding:0 0.55in;display:flex;justify-content:space-between;">
          <span>Case ${escapeHtml(options.caseId)} · Output ${escapeHtml(options.outputId)}</span>
          <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
        </div>`,
      });
      const pdf = await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(`PDF rendering timed out after ${options.timeoutMs}ms`),
            ),
          options.timeoutMs,
        );
        pdfPromise.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
      this.lastError = null;
      return pdf;
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  async health() {
    try {
      await access(this.executablePath);
      const dependencyCheck = await execFileAsync("ldd", [this.executablePath], {
        env: process.env,
        maxBuffer: 1024 * 1024,
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return { stdout: "", stderr: "" };
        }
        throw error;
      });
      const dependencyOutput = `${dependencyCheck.stdout}\n${dependencyCheck.stderr}`;
      const missing = dependencyOutput
        .split("\n")
        .filter((line) => line.includes("not found"))
        .map((line) => line.trim());
      if (missing.length > 0) {
        throw new Error(`Chromium dependencies missing: ${missing.join("; ")}`);
      }
      return {
        configured: true,
        available: true,
        launched: Boolean(this.browser?.isConnected()),
        executablePath: this.executablePath,
        ...(this.lastError ? { error: this.lastError } : {}),
      };
    } catch (error) {
      return {
        configured: true,
        available: false,
        launched: false,
        executablePath: this.executablePath,
        error: this.lastError || errorMessage(error),
      };
    }
  }

  async shutdown(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }
}

export class CaseOutputManager {
  private readonly records = new Map<string, CaseOutputRecord>();
  private readonly outputIdByKey = new Map<string, string>();
  private initialized = false;
  private initialization: Promise<void> | null = null;
  private readonly pending: QueueItem[] = [];
  private readonly queuedIds = new Set<string>();
  private active = 0;
  private idleWaiters: Array<() => void> = [];
  private creationChain: Promise<void> = Promise.resolve();
  private lastError: string | null = null;
  private pdfRendererState: Awaited<
    ReturnType<CaseOutputPdfRenderer["health"]>
  > | null = null;

  constructor(
    private readonly config: CaseOutputConfig,
    private readonly emit: CaseOutputEventEmitter,
    private readonly cases: CaseOutputCaseProvider,
    private readonly retrievals: CaseOutputRetrievalProvider,
    private readonly pdfRenderer: CaseOutputPdfRenderer = new PlaywrightCaseOutputPdfRenderer(),
  ) {}

  health() {
    const values = Array.from(this.records.values());
    return {
      enabled: this.config.enabled,
      available: this.config.available,
      unavailableReasons: this.config.unavailableReasons,
      caseDataDir: this.config.caseDataDir,
      formats: this.config.formats,
      templateVersion: this.config.templateVersion,
      language: this.config.language,
      pdfTimeoutMs: this.config.pdfTimeoutMs,
      maxConcurrent: this.config.maxConcurrent,
      outputs: values.length,
      queued: values.filter((record) => record.status === "queued").length,
      processing: values.filter((record) => record.status === "processing").length,
      complete: values.filter((record) => record.status === "complete").length,
      partial: values.filter((record) => record.status === "partial").length,
      failed: values.filter((record) => record.status === "failed").length,
      active: this.active,
      pdfRenderer: this.pdfRendererState,
      lastError: this.lastError,
    };
  }

  async runtimeHealth() {
    this.pdfRendererState = this.config.formats.includes("pdf")
      ? await this.pdfRenderer.health()
      : {
          configured: false,
          available: true,
          launched: false,
          executablePath: "",
        };
    return {
      ...this.health(),
      pdfRenderer: this.pdfRendererState,
    };
  }

  async start(): Promise<void> {
    if (!this.config.enabled || !this.config.available) {
      return;
    }
    await this.initialize();
    await this.runtimeHealth();
  }

  async shutdown(): Promise<void> {
    await this.waitForIdle();
    await this.pdfRenderer.shutdown();
  }

  async waitForIdle(): Promise<void> {
    if (this.active === 0 && this.pending.length === 0) {
      return;
    }
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  registerRoutes(app: Express): void {
    app.get("/cases/:caseId/outputs", async (req, res) => {
      const caseResult = await this.cases.get(req.params.caseId);
      if (!caseResult) {
        res.status(404).json({ ok: false, error: "Case workspace not found" });
        return;
      }
      const revisionId =
        typeof req.query.revisionId === "string" ? req.query.revisionId : undefined;
      const status =
        typeof req.query.status === "string" &&
        ["queued", "processing", "complete", "partial", "failed"].includes(
          req.query.status,
        )
          ? (req.query.status as CaseOutputStatus)
          : undefined;
      res.json({
        ok: true,
        outputs: this.list(req.params.caseId, { revisionId, status }),
      });
    });

    app.get("/cases/:caseId/outputs/:outputId", async (req, res) => {
      const record = this.recordForCase(req.params.caseId, req.params.outputId);
      if (!record) {
        res.status(404).json({ ok: false, error: "Case output not found" });
        return;
      }
      res.json({ ok: true, output: record });
    });

    app.get("/cases/:caseId/outputs/:outputId/files/:format", async (req, res) => {
      const format = req.params.format as CaseOutputFormat;
      if (!["json", "html", "pdf"].includes(format)) {
        res.status(400).json({ ok: false, error: "Invalid output format" });
        return;
      }
      const record = this.recordForCase(req.params.caseId, req.params.outputId);
      const artifact = record?.artifacts.find(
        (item) => item.format === format && item.status === "ready",
      );
      if (!record || !artifact) {
        res.status(404).json({ ok: false, error: "Output artifact not found" });
        return;
      }
      const filePath = this.artifactPath(record, format);
      res.setHeader("Content-Type", artifact.mimeType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${artifact.fileName}"`,
      );
      if (artifact.sha256) {
        res.setHeader("X-Content-SHA256", artifact.sha256);
      }
      res.sendFile(path.resolve(filePath), (error) => {
        if (error && !res.headersSent) {
          const statusCode =
            "statusCode" in error && typeof error.statusCode === "number"
              ? error.statusCode
              : 500;
          res.status(statusCode).json({
            ok: false,
            error: errorMessage(error),
          });
        }
      });
    });

    app.post("/cases/:caseId/outputs", async (req, res) => {
      try {
        const result = await this.cases.get(req.params.caseId);
        if (!result) {
          res.status(404).json({ ok: false, error: "Case workspace not found" });
          return;
        }
        const revisionId =
          typeof req.body?.revisionId === "string" && req.body.revisionId.trim()
            ? req.body.revisionId.trim()
            : result.workspace.currentRevisionId;
        if (!revisionId) {
          res.status(409).json({ ok: false, error: "Case has no completed revision" });
          return;
        }
        const retrievalIds = Array.isArray(req.body?.retrievalIds)
          ? req.body.retrievalIds.filter(
              (value: unknown): value is string =>
                typeof value === "string" && Boolean(value.trim()),
            )
          : undefined;
        const output = await this.create(req.params.caseId, revisionId, retrievalIds);
        res.status(202).json({ ok: true, output });
      } catch (error) {
        const message = errorMessage(error);
        res
          .status(message.includes("not found") ? 404 : message.includes("disabled") ? 503 : 409)
          .json({ ok: false, error: message });
      }
    });

    app.post("/cases/:caseId/outputs/:outputId/retry", async (req, res) => {
      try {
        const record = this.recordForCase(req.params.caseId, req.params.outputId);
        if (!record) {
          res.status(404).json({ ok: false, error: "Case output not found" });
          return;
        }
        await this.retry(record.outputId);
        this.emit("case-output-retry-requested", {
          caseId: record.caseId,
          outputId: record.outputId,
        });
        res.status(202).json({ ok: true, output: record });
      } catch (error) {
        res.status(409).json({ ok: false, error: errorMessage(error) });
      }
    });
  }

  async onCaseRevisionCompleted(
    workspace: CaseWorkspace,
    revision: CaseRevision,
  ): Promise<void> {
    if (!this.config.enabled || !this.config.available || workspace.status !== "complete") {
      return;
    }
    await this.create(workspace.caseId, revision.revisionId, []);
  }

  async onRetrievalCompleted(record: RetrievalRecord): Promise<void> {
    if (
      !this.config.enabled ||
      !this.config.available ||
      !record.caseId ||
      !record.revisionId ||
      !this.isEligibleRetrieval(record)
    ) {
      return;
    }
    const eligible = await this.eligibleRetrievals(
      record.caseId,
      record.revisionId,
    );
    if (eligible.length === 0) {
      return;
    }
    const existingOutputIds = new Set(
      this.list(record.caseId).map((output) => output.outputId),
    );
    const output = await this.create(
      record.caseId,
      record.revisionId,
      eligible.map((item) => item.retrievalId),
    );
    if (!existingOutputIds.has(output.outputId)) {
      this.emit("case-output-evidence-version-created", {
        caseId: output.caseId,
        revisionId: output.revisionId,
        outputId: output.outputId,
        outputVersion: output.outputVersion,
        retrievalIds: output.retrievalIds,
      });
    }
  }

  async create(
    caseId: string,
    revisionId: string,
    requestedRetrievalIds?: string[],
  ): Promise<CaseOutputRecord> {
    if (!this.config.enabled) {
      throw new Error("Case output is disabled");
    }
    if (!this.config.available) {
      throw new Error(
        `Case output is unavailable: ${this.config.unavailableReasons.join(", ")}`,
      );
    }
    await this.initialize();
    return this.withCreationLock(async () => {
      const caseResult = await this.cases.get(caseId);
      const revision = await this.cases.revision(caseId, revisionId);
      if (!caseResult || !revision || !caseResult.workspace.revisionIds.includes(revisionId)) {
        throw new Error(`Case revision not found: ${caseId}/${revisionId}`);
      }
      if (caseResult.workspace.status !== "complete") {
        throw new Error("Case workspace must be complete before creating output");
      }
      const eligible = await this.eligibleRetrievals(caseId, revisionId);
      const retrievalIds =
        requestedRetrievalIds === undefined
          ? eligible.map((item) => item.retrievalId)
          : Array.from(new Set(requestedRetrievalIds)).sort();
      const eligibleIds = new Set(eligible.map((item) => item.retrievalId));
      const invalid = retrievalIds.filter((retrievalId) => !eligibleIds.has(retrievalId));
      if (invalid.length > 0) {
        throw new Error(
          `Retrieval records are not complete/partial for this revision: ${invalid.join(", ")}`,
        );
      }
      retrievalIds.sort();
      const idempotencyKey = this.idempotencyKey(revisionId, retrievalIds);
      const existingId = this.outputIdByKey.get(idempotencyKey);
      if (existingId) {
        const existing = this.records.get(existingId);
        if (existing) {
          return existing;
        }
      }
      const outputVersion =
        Math.max(
          0,
          ...Array.from(this.records.values())
            .filter((record) => record.caseId === caseId)
            .map((record) => record.outputVersion),
        ) + 1;
      const record: CaseOutputRecord = {
        schemaVersion: 1,
        outputId: randomUUID(),
        outputVersion,
        caseId,
        revisionId,
        retrievalIds,
        templateVersion: this.config.templateVersion,
        language: this.config.language,
        status: "queued",
        artifacts: [],
        warnings: [],
        retryable: false,
        idempotencyKey,
        createdAt: new Date().toISOString(),
      };
      this.registerRecord(record);
      await this.saveManifest(record);
      await this.log(record.caseId, {
        event: "queued",
        outputId: record.outputId,
        revisionId,
        retrievalIds,
        createdAt: record.createdAt,
      });
      this.emit("case-output-queued", {
        caseId,
        revisionId,
        outputId: record.outputId,
        outputVersion,
        retrievalIds,
      });
      this.enqueue(record.outputId, false);
      return record;
    });
  }

  async retry(outputId: string): Promise<void> {
    await this.initialize();
    const record = this.records.get(outputId);
    if (!record) {
      throw new Error(`Case output not found: ${outputId}`);
    }
    if (record.status !== "failed" && record.status !== "partial") {
      throw new Error("Only failed or partial outputs can be retried");
    }
    record.status = "queued";
    record.retryable = false;
    record.completedAt = undefined;
    await this.saveManifest(record);
    this.enqueue(outputId, true);
  }

  list(
    caseId: string,
    options: { revisionId?: string; status?: CaseOutputStatus } = {},
  ): CaseOutputRecord[] {
    return Array.from(this.records.values())
      .filter(
        (record) =>
          record.caseId === caseId &&
          (!options.revisionId || record.revisionId === options.revisionId) &&
          (!options.status || record.status === options.status),
      )
      .sort((left, right) => right.outputVersion - left.outputVersion);
  }

  private async initialize(): Promise<void> {
    if (this.initialized || !this.config.enabled) {
      return;
    }
    if (this.initialization) {
      return this.initialization;
    }
    this.initialization = (async () => {
      let caseEntries: Array<{ isDirectory(): boolean; name: string }> = [];
      try {
        caseEntries = await readdir(this.config.caseDataDir, {
          withFileTypes: true,
        });
      } catch {
        caseEntries = [];
      }
      const recovered: QueueItem[] = [];
      for (const caseEntry of caseEntries) {
        if (!caseEntry.isDirectory()) {
          continue;
        }
        const outputsDir = path.join(
          this.config.caseDataDir,
          caseEntry.name,
          "outputs",
        );
        let outputEntries: Array<{ isDirectory(): boolean; name: string }> = [];
        try {
          outputEntries = await readdir(outputsDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const outputEntry of outputEntries) {
          if (!outputEntry.isDirectory()) {
            continue;
          }
          try {
            const record = await readJson<CaseOutputRecord>(
              path.join(outputsDir, outputEntry.name, "manifest.json"),
            );
            if (record.caseId !== caseEntry.name || record.outputId !== outputEntry.name) {
              throw new Error("Output manifest path identifiers do not match");
            }
            if (record.status === "processing") {
              record.status = "failed";
              record.retryable = true;
              record.warnings.push("Output generation was interrupted by a process restart");
              record.completedAt = new Date().toISOString();
              await this.saveManifest(record);
            }
            this.registerRecord(record);
            if (record.status === "queued") {
              recovered.push({ outputId: record.outputId, retry: false });
            }
          } catch (error) {
            this.lastError = errorMessage(error);
            this.emit("case-output-failed", {
              caseId: caseEntry.name,
              outputId: outputEntry.name,
              reason: "manifest-load-failed",
              message: errorMessage(error),
            });
          }
        }
      }
      this.initialized = true;
      for (const item of recovered) {
        this.enqueue(item.outputId, item.retry);
      }
    })();
    try {
      await this.initialization;
    } finally {
      this.initialization = null;
    }
  }

  private enqueue(outputId: string, retry: boolean): void {
    if (this.queuedIds.has(outputId)) {
      return;
    }
    this.queuedIds.add(outputId);
    this.pending.push({ outputId, retry });
    this.pump();
  }

  private pump(): void {
    while (this.active < this.config.maxConcurrent && this.pending.length > 0) {
      const item = this.pending.shift();
      if (!item) {
        break;
      }
      this.queuedIds.delete(item.outputId);
      this.active += 1;
      void this.generate(item)
        .catch((error) => {
          this.lastError = errorMessage(error);
        })
        .finally(() => {
          this.active -= 1;
          this.pump();
          this.resolveIdleIfNeeded();
        });
    }
  }

  private async generate(item: QueueItem): Promise<void> {
    const record = this.records.get(item.outputId);
    if (!record) {
      return;
    }
    record.status = "processing";
    record.retryable = false;
    record.warnings = item.retry
      ? record.warnings.filter(
          (warning) => !warning.startsWith("Artifact ") && !warning.includes("interrupted"),
        )
      : record.warnings;
    await this.saveManifest(record);
    await this.log(record.caseId, {
      event: "started",
      outputId: record.outputId,
      retry: item.retry,
      createdAt: new Date().toISOString(),
    });
    this.emit("case-output-generation-started", {
      caseId: record.caseId,
      revisionId: record.revisionId,
      outputId: record.outputId,
      retry: item.retry,
    });

    try {
      const jsonReady = record.artifacts.some(
        (artifact) => artifact.format === "json" && artifact.status === "ready",
      );
      const htmlReady = record.artifacts.some(
        (artifact) => artifact.format === "html" && artifact.status === "ready",
      );
      let packet: CaseOutputPacket | null = jsonReady
        ? await readJson<CaseOutputPacket>(this.artifactPath(record, "json"))
        : null;
      let html: string | null = htmlReady
        ? await readFile(this.artifactPath(record, "html"), "utf8")
        : null;

      if (
        !packet &&
        (!html ||
          this.config.formats.some(
            (format) =>
              format === "json" &&
              !record.artifacts.some(
                (artifact) =>
                  artifact.format === format && artifact.status === "ready",
              ),
          ))
      ) {
        const caseResult = await this.cases.get(record.caseId);
        const revision = await this.cases.revision(
          record.caseId,
          record.revisionId,
        );
        if (!caseResult || !revision) {
          throw new Error("Case workspace or revision is no longer available");
        }
        const allRetrievals = await this.retrievals.recordsForCase(record.caseId);
        const retrievalById = new Map(
          allRetrievals.map((retrieval) => [retrieval.retrievalId, retrieval]),
        );
        const selectedRetrievals = record.retrievalIds.map((retrievalId) => {
          const retrieval = retrievalById.get(retrievalId);
          if (
            !retrieval ||
            retrieval.revisionId !== record.revisionId ||
            !this.isEligibleRetrieval(retrieval)
          ) {
            throw new Error(`Retrieval snapshot is unavailable: ${retrievalId}`);
          }
          return retrieval;
        });
        packet = buildCaseOutputPacket(
          record,
          caseResult.workspace,
          revision,
          selectedRetrievals,
        );
      }
      if (!html && packet) {
        html = renderCaseOutputHtml(packet);
      }

      for (const format of this.config.formats) {
        const existing = record.artifacts.find(
          (artifact) => artifact.format === format && artifact.status === "ready",
        );
        if (existing) {
          continue;
        }
        try {
          const value =
            format === "json"
              ? `${JSON.stringify(
                  packet ?? (() => {
                    throw new Error("Case output packet is unavailable");
                  })(),
                  null,
                  2,
                )}\n`
              : format === "html"
                ? html ??
                  (() => {
                    throw new Error("Case output HTML is unavailable");
                  })()
                : await this.pdfRenderer.render(
                    html ??
                      (() => {
                        throw new Error("Case output HTML is unavailable");
                      })(),
                    {
                    caseId: record.caseId,
                    outputId: record.outputId,
                    timeoutMs: this.config.pdfTimeoutMs,
                    },
                  );
          await atomicWrite(this.artifactPath(record, format), value);
          const fileStat = await stat(this.artifactPath(record, format));
          this.upsertArtifact(record, {
            format,
            status: "ready",
            mimeType: FORMAT_METADATA[format].mimeType,
            fileName: this.downloadFileName(record, format),
            sizeBytes: fileStat.size,
            sha256: sha256(value),
          });
          if (format === "pdf") {
            this.pdfRendererState = await this.pdfRenderer.health();
          }
        } catch (error) {
          const message = errorMessage(error);
          this.upsertArtifact(record, {
            format,
            status: "failed",
            mimeType: FORMAT_METADATA[format].mimeType,
            fileName: this.downloadFileName(record, format),
            error: message,
          });
          record.warnings.push(`Artifact ${format} failed: ${message}`);
          if (format === "pdf") {
            this.pdfRendererState = await this.pdfRenderer.health();
          }
        }
        await this.saveManifest(record);
      }

      const ready = record.artifacts.filter((artifact) => artifact.status === "ready");
      const failed = record.artifacts.filter((artifact) => artifact.status === "failed");
      record.status =
        ready.length === this.config.formats.length
          ? "complete"
          : ready.length > 0
            ? "partial"
            : "failed";
      record.retryable = failed.length > 0;
      record.completedAt = new Date().toISOString();
      await this.saveManifest(record);
      await this.log(record.caseId, {
        event: record.status,
        outputId: record.outputId,
        artifacts: record.artifacts,
        createdAt: record.completedAt,
      });
      const event =
        record.status === "complete"
          ? "case-output-completed"
          : record.status === "partial"
            ? "case-output-partial"
            : "case-output-failed";
      this.emit(event, {
        caseId: record.caseId,
        revisionId: record.revisionId,
        outputId: record.outputId,
        outputVersion: record.outputVersion,
        artifacts: record.artifacts,
        warnings: record.warnings,
      });
    } catch (error) {
      record.status = "failed";
      record.retryable = true;
      record.completedAt = new Date().toISOString();
      record.warnings.push(errorMessage(error));
      await this.saveManifest(record);
      await this.log(record.caseId, {
        event: "failed",
        outputId: record.outputId,
        message: errorMessage(error),
        createdAt: record.completedAt,
      });
      this.emit("case-output-failed", {
        caseId: record.caseId,
        revisionId: record.revisionId,
        outputId: record.outputId,
        message: errorMessage(error),
      });
    }
  }

  private async eligibleRetrievals(
    caseId: string,
    revisionId: string,
  ): Promise<RetrievalRecord[]> {
    return (await this.retrievals.recordsForCase(caseId))
      .filter(
        (record) =>
          record.caseId === caseId &&
          record.revisionId === revisionId &&
          this.isEligibleRetrieval(record),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private isEligibleRetrieval(record: RetrievalRecord): boolean {
    return (
      record.status === "complete" ||
      (record.status === "partial" &&
        (record.historicalCases.length > 0 || record.literature.length > 0))
    );
  }

  private registerRecord(record: CaseOutputRecord): void {
    this.records.set(record.outputId, record);
    this.outputIdByKey.set(record.idempotencyKey, record.outputId);
  }

  private recordForCase(caseId: string, outputId: string): CaseOutputRecord | null {
    const record = this.records.get(outputId);
    return record?.caseId === caseId ? record : null;
  }

  private upsertArtifact(
    record: CaseOutputRecord,
    artifact: CaseOutputArtifact,
  ): void {
    const index = record.artifacts.findIndex(
      (existing) => existing.format === artifact.format,
    );
    if (index >= 0) {
      record.artifacts[index] = artifact;
    } else {
      record.artifacts.push(artifact);
    }
    record.artifacts.sort(
      (left, right) =>
        this.config.formats.indexOf(left.format) -
        this.config.formats.indexOf(right.format),
    );
  }

  private idempotencyKey(revisionId: string, retrievalIds: string[]): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          revisionId,
          retrievalIds: [...retrievalIds].sort(),
          templateVersion: this.config.templateVersion,
          language: this.config.language,
        }),
      )
      .digest("hex");
  }

  private outputDir(record: Pick<CaseOutputRecord, "caseId" | "outputId">): string {
    return path.join(
      this.config.caseDataDir,
      sanitizePathPart(record.caseId),
      "outputs",
      sanitizePathPart(record.outputId),
    );
  }

  private manifestPath(
    record: Pick<CaseOutputRecord, "caseId" | "outputId">,
  ): string {
    return path.join(this.outputDir(record), "manifest.json");
  }

  private artifactPath(
    record: Pick<CaseOutputRecord, "caseId" | "outputId">,
    format: CaseOutputFormat,
  ): string {
    return path.join(this.outputDir(record), FORMAT_METADATA[format].storageName);
  }

  private downloadFileName(
    record: Pick<CaseOutputRecord, "caseId" | "outputVersion">,
    format: CaseOutputFormat,
  ): string {
    return `echo-case-${sanitizePathPart(record.caseId)}-v${record.outputVersion}.${format}`;
  }

  private saveManifest(record: CaseOutputRecord): Promise<void> {
    return atomicWriteJson(this.manifestPath(record), record);
  }

  private async log(caseId: string, entry: unknown): Promise<void> {
    const filePath = path.join(
      this.config.caseDataDir,
      sanitizePathPart(caseId),
      "output-generation.ndjson",
    );
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  private async withCreationLock<T>(task: () => Promise<T>): Promise<T> {
    let resolveCurrent!: () => void;
    const previous = this.creationChain;
    this.creationChain = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      resolveCurrent();
    }
  }

  private resolveIdleIfNeeded(): void {
    if (this.active !== 0 || this.pending.length !== 0) {
      return;
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}
