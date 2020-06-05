// @ts-check
const yargs = require('yargs')
const uuidv4 = require('uuid').v4
const { GhkvDataStore } = require('./lib')
const { GhkvResourceLock } = require('./lib/contrib/resource-lock')

function createStore() {
  const store = new GhkvDataStore({
    owner: 'taskworld',
    repo: 'ghkv',
    branch: 'datastore',
    accessToken: process.env.GITHUB_TOKEN,
  })
  return store
}

yargs
  .demandCommand()
  .strict()
  .help()
  .command(
    'get <key>',
    'Get data from the datastore',
    { key: { type: 'string' } },
    async (args) => {
      const store = createStore()
      const doc = store.doc(args.key)
      const result = await doc.get()
      console.log(JSON.stringify(result, null, 2))
    }
  )
  .command(
    'set <key> <value>',
    'Set data to the datastore',
    { key: { type: 'string' }, value: { type: 'string' } },
    async (args) => {
      const store = createStore()
      const doc = store.doc(args.key)
      const result = await doc.set(JSON.parse(args.value))
      console.log(JSON.stringify(result, null, 2))
    }
  )
  .command('test:counter', 'Add to a shared counter', {}, async (args) => {
    const store = createStore()
    const doc = store.doc('examples/counter')
    const result = await doc.update((item = {}) => {
      return { ...item, count: (+item.count || 0) + 1 }
    })
    console.log(JSON.stringify(result, null, 2))
  })
  .command(
    'test:counter-concurrent',
    'Add to a shared counter',
    {},
    async (args) => {
      const store = createStore()
      const doc = store.doc('examples/counter')
      const updateFn = (item = {}) => {
        return { ...item, count: (+item.count || 0) + 1 }
      }
      const result = await Promise.all([
        doc.update(updateFn),
        doc.update(updateFn),
        doc.update(updateFn),
      ])
      console.log(JSON.stringify(result, null, 2))
    }
  )
  .command('test:multi-store', 'Multiple store test', {}, async (args) => {
    const storeA = createStore()
    const storeB = createStore()
    await storeA.doc('examples/hello').get()
    await storeB.doc('examples/hello').set({ ok: true })
    const result = await storeA
      .doc('examples/hello')
      .update((x) => ({ ...x, foo: 'bar' }))
    console.log(JSON.stringify(result, null, 2))
  })
  .command('test:queue', 'Test queueing up', {}, async (args) => {
    const id = uuidv4()
    const log = (format, ...args) => console.error(`[${id}] ${format}`, ...args)
    log('Consumer initialized')

    const store = createStore()
    const lock = new GhkvResourceLock(store, 'examples/distributed-queue')
    lock.log = log
    const acquiredLock = await lock.acquire()
    try {
      for (let i = 1; i <= 100; i++) {
        log('Working: ' + i + '%')
        await delay(1000)
      }
    } finally {
      await acquiredLock.release()
    }
  })
  .parse()

const delay = (t) => {
  let timeout
  const promise = new Promise((resolve) => (timeout = setTimeout(resolve, t)))
  return Object.assign(promise, { timeout })
}
