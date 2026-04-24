/**
 * metrics.ts — In-memory metrics ring buffer.
 *
 * Stub GPU metrics: ~1h at 30s intervals = 120 points (use 360 for safety).
 * Task metrics: 1000 points per task.
 * Task direct metrics (task.metrics event): 500 points per metric key per task.
 * Not persisted (ephemeral).
 */

export const TASK_METRICS_BUFFER_SIZE = 500;

import { GpuStatEntry } from "./types";

export interface MetricPoint {
  timestamp: number;
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
    const start = this.head;
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

// Per-key task metrics buffer: task_id → metric_key → [{step, value, ts}]
type TaskMetricsBuffer = Map<string, Map<string, Array<{ step: number; value: number; ts: string }>>>;

class MetricsStore {
  private stubMetrics: Map<string, RingBuffer> = new Map();
  private taskMetrics: Map<string, RingBuffer> = new Map();
  // Direct task metrics (from task.metrics event) — keyed per metric name
  private taskMetricsDirect: TaskMetricsBuffer = new Map();

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
      if (gpu.temperature_c !== undefined) {
        values[`${prefix}.temperature_c`] = gpu.temperature_c;
      }
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

  /** Push structured metrics from the task.metrics socket event. */
  pushTaskMetricsDirect(taskId: string, step: number, metrics: Record<string, number>): void {
    if (!this.taskMetricsDirect.has(taskId)) {
      this.taskMetricsDirect.set(taskId, new Map());
    }
    const taskMap = this.taskMetricsDirect.get(taskId)!;
    const ts = new Date().toISOString();
    for (const [key, value] of Object.entries(metrics)) {
      if (!taskMap.has(key)) {
        taskMap.set(key, []);
      }
      const arr = taskMap.get(key)!;
      arr.push({ step, value, ts });
      if (arr.length > TASK_METRICS_BUFFER_SIZE) {
        arr.splice(0, arr.length - TASK_METRICS_BUFFER_SIZE);
      }
    }
  }

  /** Get structured metrics buffer for a task. */
  getTaskMetricsDirect(taskId: string): Record<string, Array<{ step: number; value: number; ts: string }>> {
    const taskMap = this.taskMetricsDirect.get(taskId);
    if (!taskMap) return {};
    const result: Record<string, Array<{ step: number; value: number; ts: string }>> = {};
    for (const [key, arr] of taskMap.entries()) {
      result[key] = [...arr];
    }
    return result;
  }

  getLatestStubMetrics(): Record<string, MetricPoint | null> {
    const result: Record<string, MetricPoint | null> = {};
    for (const [stubId, buf] of this.stubMetrics.entries()) {
      const all = buf.getAll();
      result[stubId] = all.length > 0 ? all[all.length - 1] : null;
    }
    return result;
  }
}

export const metricsStore = new MetricsStore();
