// A call waiting for a strategy to let it through, linked into a FIFO queue it can leave from anywhere in O(1), as an
// abort or an expired wait does.
export interface Waiter {
  prev: Waiter | undefined
  next: Waiter | undefined
  queued: boolean
}

export class Waiters<W extends Waiter> {
  #head: W | undefined
  #tail: W | undefined
  #size = 0

  get size(): number {
    return this.#size
  }

  get first(): W | undefined {
    return this.#head
  }

  get last(): W | undefined {
    return this.#tail
  }

  push(waiter: W): void {
    waiter.prev = this.#tail
    waiter.next = undefined
    waiter.queued = true
    if (this.#tail === undefined) {
      this.#head = waiter
    } else {
      this.#tail.next = waiter
    }
    this.#tail = waiter
    this.#size++
  }

  shift(): W | undefined {
    const waiter = this.#head
    if (waiter !== undefined) {
      this.remove(waiter)
    }
    return waiter
  }

  // A waiter already out of the queue is left alone, so whichever of its expiry, its abort and its turn comes second
  // finds it gone.
  remove(waiter: W): boolean {
    if (!waiter.queued) {
      return false
    }

    if (waiter.prev === undefined) {
      this.#head = waiter.next as W | undefined
    } else {
      waiter.prev.next = waiter.next
    }
    if (waiter.next === undefined) {
      this.#tail = waiter.prev as W | undefined
    } else {
      waiter.next.prev = waiter.prev
    }
    waiter.prev = undefined
    waiter.next = undefined
    waiter.queued = false
    this.#size--
    return true
  }
}
