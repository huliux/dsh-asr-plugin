import type { JobHandle, JobOutcome, JobRegistry } from "@deepseek-ai/dsh-jobs";
import { ModelDownloadError, modelProxyUrl } from "./model-download-contract.js";
import type { ModelDownloadControl, ModelDownloadPack, ModelDownloadSettings, ModelDownloadStatus } from "./model-download-contract.js";
import { installDownloadedModels } from "./model-download-operation.js";
import type { ModelDownloadTransport } from "./model-download-transport.js";

declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap { "asr-model-download": "asr-model-download"; }
}
interface Input {
  readonly dataRoot: string;
  readonly packageRoot: string;
  readonly transport: ModelDownloadTransport;
  readonly jobs: Pick<JobRegistry, "start">;
  readonly settings: () => ModelDownloadSettings;
}
export class ModelDownloadController implements ModelDownloadControl {
  private view: ModelDownloadStatus = { pack: null, phase: "idle", downloadedBytes: 0,
    totalBytes: 0, jobId: null, errorCode: null };
  private active: { abort: AbortController; done: Promise<JobOutcome> } | undefined;
  private disposed = false;
  constructor(private readonly input: Input) {}
  status(): ModelDownloadStatus { return { ...this.view }; }
  async start(pack: ModelDownloadPack): Promise<ModelDownloadStatus> {
    if (this.disposed) throw new ModelDownloadError("MODEL_DOWNLOAD_UNAVAILABLE");
    if (this.active !== undefined) throw new ModelDownloadError("MODEL_DOWNLOAD_BUSY");
    const settings = { ...this.input.settings() };
    if (settings.route === "proxy" && settings.proxyKind !== "mirror") settings.proxyUrl = modelProxyUrl(settings.proxyUrl);
    const abort = new AbortController();
    const id = this.input.jobs.start({ kind: "asr-model-download", label: `Install ASR ${pack} models`,
      outputLimitBytes: 1_024, run: job => {
        this.view = { pack, phase: "downloading", downloadedBytes: 0, totalBytes: 0,
          jobId: String(job.id), errorCode: null };
        const done = this.run(pack, settings, abort.signal, job);
        this.active = { abort, done };
        return { cancel: () => abort.abort(), done };
      } });
    this.view = { ...this.view, jobId: String(id) };
    return this.status();
  }
  async cancel(): Promise<ModelDownloadStatus> {
    const active = this.active;
    if (active !== undefined) { active.abort.abort(); await active.done; }
    return this.status();
  }
  async dispose(): Promise<void> { this.disposed = true; await this.cancel(); }
  private async run(pack: ModelDownloadPack, settings: ModelDownloadSettings, signal: AbortSignal, job: JobHandle): Promise<JobOutcome> {
    try {
      await installDownloadedModels({ ...this.input, pack, settings, signal, update: update => {
        this.view = { ...this.view, ...update };
        job.updateProgress(`${this.view.phase} ${this.view.downloadedBytes}/${this.view.totalBytes}`);
      } });
      this.view = { ...this.view, phase: "completed" };
      return { status: "completed" };
    } catch (error) {
      const code = error instanceof ModelDownloadError ? error.code : "MODEL_DOWNLOAD_FAILED";
      this.view = { ...this.view, phase: signal.aborted ? "cancelled" : "failed", errorCode: signal.aborted ? null : code };
      return { status: signal.aborted ? "killed" : "failed", detail: code };
    } finally { this.active = undefined; }
  }
}
