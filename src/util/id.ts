/**
 * Sequential ID generator based on millisecond timestamps.
 * Each call returns a unique ID by incrementing from the initial timestamp.
 */
export class IdGenerator {
  private counter: number;

  constructor(startFrom?: number) {
    this.counter = startFrom ?? Date.now();
  }

  next(): number {
    return this.counter++;
  }
}
