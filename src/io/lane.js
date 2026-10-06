// A concurrency limit for background fetches. Queued tasks can be promoted (started at once, outside the limit) when
// an engine thread turns out to be blocked on them, and the queue can be trimmed when it grows faster than it drains.

export class DroppedError extends Error {
  constructor() {
    super('dropped from the fetch queue');
    this.name = 'DroppedError';
  }
}

export class Lane {
  constructor(limit) {
    this.limit = Math.max(1, limit | 0);
    this.active = 0;
    this.queue = [];
  }

  // fn(promoted) runs when a place is free; returns { promise, promote }.
  run(fn) {
    const task = { fn, started: false, counted: false, resolve: null, reject: null };
    const promise = new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
    });
    const promote = () => {
      if (task.started) return;
      const i = this.queue.indexOf(task);
      if (i >= 0) this.queue.splice(i, 1);
      this.#start(task, true, false);
    };
    this.queue.push(task);
    this.#pump();
    return { promise, promote };
  }

  // Drops the oldest queued tasks beyond `max`; they reject with DroppedError.
  trim(max) {
    while (this.queue.length > max) {
      const task = this.queue.shift();
      task.started = true;
      task.reject(new DroppedError());
    }
  }

  get queued() {
    return this.queue.length;
  }

  #start(task, promoted, counted) {
    task.started = true;
    task.counted = counted;
    if (counted) this.active++;
    Promise.resolve()
      .then(() => task.fn(promoted))
      .then(task.resolve, task.reject)
      .finally(() => {
        if (task.counted) this.active--;
        this.#pump();
      });
  }

  #pump() {
    while (this.active < this.limit && this.queue.length) this.#start(this.queue.shift(), false, true);
  }
}
