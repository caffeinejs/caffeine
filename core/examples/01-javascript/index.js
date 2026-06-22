import { DiCaf } from '@caffeine/core'

// --- Services ---

class Logger {
  info(msg) {
    console.log(`[INFO]  ${msg}`)
  }

  error(msg) {
    console.error(`[ERROR] ${msg}`)
  }
}

class Storage {
  #items = new Map()
  #seq = 1

  constructor(logger) {
    this.logger = logger
  }

  save(item) {
    const id = this.#seq++
    const record = { id, ...item }
    this.#items.set(id, record)
    this.logger.info(`Saved item #${id}: "${item.title}"`)
    return record
  }

  findAll() {
    return [...this.#items.values()]
  }

  delete(id) {
    const existed = this.#items.has(id)
    this.#items.delete(id)
    if (existed) {
      this.logger.info(`Deleted item #${id}`)
    }
    return existed
  }
}

class TodoService {
  constructor(storage, logger) {
    this.storage = storage
    this.logger = logger
  }

  add(title) {
    return this.storage.save({ title, done: false })
  }

  complete(id) {
    const todo = this.storage.findAll()
      .find(t => t.id === id)
    if (!todo) {
      this.logger.error(`Todo #${id} not found`)
      return null
    }
    todo.done = true
    this.logger.info(`Marked done: "${todo.title}"`)
    return todo
  }

  remove(id) {
    return this.storage.delete(id)
  }

  list() {
    return this.storage.findAll()
  }
}

// --- Wire up ---

const kLogger = 'logger'
const kStorage = 'storage'
const kTodoService = 'todo-service'

const di = new DiCaf()

di.bind(kLogger)
  .toClass(Logger)
di.bind(kStorage)
  .toClass(Storage, [kLogger])
di.bind(kTodoService)
  .toClass(TodoService, [kStorage, kLogger])

// --- Run ---

await di.init()

const todos = di.get(kTodoService)

todos.add('Buy groceries')
todos.add('Read a book')
todos.add('Write some code')
todos.complete(2)
todos.complete(99)
todos.remove(1)

console.log('\nCurrent list:')
for (const todo of todos.list()) {
  const status = todo.done ? '[x]' : '[ ]'
  console.log(`  ${status} #${todo.id} ${todo.title}`)
}
