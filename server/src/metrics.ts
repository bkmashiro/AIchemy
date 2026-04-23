import { GpuStatEntry } from "./types";

export interface MetricPoint {
  timestamp: number; // Date.now()
  values: Record<string, number>;
}

export class RingBuffer {
  private buffer: MetricPoint[];
  private head: number = 0;
  private count: number = 0;
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
    this.buffer = new Array(maxSize);
  }

  push(point: MetricPoint): void {
    this.buffer[this.head] = point;
    this.head = (this.head + 1) % this.maxSize;
    if (this.count < this.maxSize) this.count++;
  }

  getAll(): MetricPoint[] {
    if (this.count === 0) return [];
    if (this.count < this.maxSize) {
      return this.buffer.slice(0, this.count);
    }
    // Full: return in chronological order starting from oldest
    const start = this.head; // head points to oldest when full
    const result: MetricPoint[] = [];
    for (let i = 0; i < this.maxSize; i++) {
      result.push(this.buffer[(start + i) % this.maxSize]);
    }
    return result;
  }

  getSince(sinceMs: number): MetricPoint[] {
    return this.getAll().filter((p) => p.timestamp >= sinceMs);
  }

  get size(): number {
    return this.count;
  }
}

class MetricsStore {
  private stubMetrics: Map<string, RingBuffer> = new Map();
  private taskMetrics: Map<string, RingBuffer> = new Map();

  pushStubMetrics(stubId: string, gpuStats: GpuStatEntry[]): void {
    if (!this.stubMetrics.has(stubId)) {
      this.stubMetrics.set(stubId, new RingBuffer(360));
    }
    const values: Record<string, number> = {};
    for (const gpu of gpuStats) {
      const prefix = `gpu${gpu.index}`;
      values[`${prefix}.utilization_pct`] = gpu.utilization_pct;
      values[`${prefix}.memory_used_mb`] = gpu.memory_used_mb;
      values[`${prefix}.memory_total_mb`] = gpu.memory_total_mb;
      values[`${prefix}.temperature_c`] = gpu.temperature_c;
    }
    this.stubMetrics.get(stubId)!.push({ timestamp: Date.now(), values });
  }

  pushTaskMetrics(taskId: string, step: number, loss?: number, metrics?: Record<string, number>): void {
    if (!this.taskMetrics.has(taskId)) {
      this.taskMetrics.set(taskId, new RingBuffer(1000));
    }
    const values: Record<string, number> = { step };
    if (loss !== undefined) values.loss = loss;
    if (metrics) {
      for (const [k, v] of Object.entries(metrics)) {
        values[k] = v;
      }
    }
    this.taskMetrics.get(taskId)!.push({ timestamp: Date.now(), values });
  }

  getStubMetrics(stubId: string, hours: number = 1): MetricPoint[] {
    const buf = this.stubMetrics.get(stubId);
    if (!buf) return [];
    const sinceMs = Date.now() - hours * 3600_000;
    return buf.getSince(sinceMs);
  }

  getTaskMetrics(taskId: string): MetricPoint[] {
    const buf = this.taskMetrics.get(taskId);
    if (!buf) return [];
    return buf.getAll();
  }

  /** Returns latest metric point for each online stub */
  getLatestStubMetrics(): Record<string, MetricPoint | null> {
    const result: Record<string, MetricPoint | null> = {};
    for (const [stubId, buf] of this.stubMetrics.entries()) {
      const all = buf.getAll();
      result[stubId] = all.length > 0 ? all[all.length - 1] : null;
    }
    return result;
  }

  cleanup(activeStubIds: string[], activeTaskIds: string[]): void {
    const activeStubSet = new Set(activeStubIds);
    const activeTaskSet = new Set(activeTaskIds);
    for (const id of this.stubMetrics.keys()) {
      if (!activeStubSet.has(id)) this.stubMetrics.delete(id);
    }
    for (const id of this.taskMetrics.keys()) {
      if (!activeTaskSet.has(id)) this.taskMetrics.delete(id);
    }
  }
}

export const metricsStore = new MetricsStore();
