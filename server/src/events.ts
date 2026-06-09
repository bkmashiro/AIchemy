import { EventEmitter } from "events";
import { Task } from "./types";

export interface TaskStatusChangedEvent {
  previous: Task;
  task: Task;
}

class AlchemyEvents extends EventEmitter {
  emitTaskStatusChanged(previous: Task, task: Task): void {
    this.emit("task.status_changed", { previous, task } satisfies TaskStatusChangedEvent);
  }

  onTaskStatusChanged(listener: (event: TaskStatusChangedEvent) => void): void {
    this.on("task.status_changed", listener);
  }
}

export const alchemyEvents = new AlchemyEvents();
