// @ts-check
const yargs = require('yargs')
const { GhkvDataStore } = require('./lib')
const { GhkvResourceLock } = require('./lib/contrib/resource-lock')
const os = require('os')
const execa = require('execa')
const expect = require('expect')

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
  .command('test:counter', 'Test basic optimistic locking', {}, async () => {
    const store = createStore()
    const doc = store.doc('examples/counter')
    doc.set({ count: 0 }, { message: `Reset counter ${by()}` })
    if (process.env.GHKV_EXAMPLE_TEST_COUNTER_MODE === 'concurrently') {
      await execa('node', ['example', 'test:counter:increment-concurrently'], {
        stdio: 'inherit',
      })
    } else {
      await Promise.all([
        execa('node', ['example', 'test:counter:increment-single'], {
          stdio: 'inherit',
        }),
        execa('node', ['example', 'test:counter:increment-single'], {
          stdio: 'inherit',
        }),
        execa('node', ['example', 'test:counter:increment-single'], {
          stdio: 'inherit',
        }),
      ])
    }
    expect((await doc.get()).count).toBe(3)
  })
  .command(
    'test:counter:increment-single',
    'Add to a shared counter',
    {},
    async () => {
      const store = createStore()
      const doc = store.doc('examples/counter')
      const result = await doc.update(
        (item = {}) => {
          return { ...item, count: (+item.count || 0) + 1 }
        },
        { message: `Increment counter ${by()}` }
      )
      console.log(JSON.stringify(result, null, 2))
    }
  )
  .command(
    'test:counter:increment-concurrently',
    'Add to a shared counter',
    {},
    async () => {
      const store = createStore()
      const doc = store.doc('examples/counter')
      const updateFn = (item = {}) => {
        return { ...item, count: (+item.count || 0) + 1 }
      }
      const result = await Promise.all([
        doc.update(updateFn, {
          message: `Increment counter ${by('1')}`,
        }),
        doc.update(updateFn, {
          message: `Increment counter ${by('2')}`,
        }),
        doc.update(updateFn, {
          message: `Increment counter ${by('3')}`,
        }),
      ])
      console.log(JSON.stringify(result, null, 2))
    }
  )
  .command(
    'test:counter-queue',
    'Test queueing up to test the counter',
    {},
    async (args) => {
      const store = createStore()
      const lock = new GhkvResourceLock(store, 'examples/counter-lock')
      const acquiredLock = await lock.acquire(
        [process.env.GITHUB_RUN_ID, os.hostname(), process.pid].join('-')
      )
      try {
        await execa('node', ['example', 'test:counter'], { stdio: 'inherit' })
      } finally {
        await acquiredLock.release()
      }
    }
  )
  .command(
    'test',
    'Test running multiple multiple tests that has a shared critical section',
    {},
    async () => {
      await Promise.all([
        execa('node', ['example', 'test:counter-queue'], {
          stdio: 'inherit',
          env: { GHKV_EXAMPLE_TEST_COUNTER_MODE: 'normal' },
        }),
        execa('node', ['example', 'test:counter-queue'], {
          stdio: 'inherit',
          env: { GHKV_EXAMPLE_TEST_COUNTER_MODE: 'concurrently' },
        }),
      ])
    }
  )
  .parse()

function by(suffix = '') {
  return `by ${os.hostname()}/${process.pid}${suffix ? ` (${suffix})` : ''}`
}
