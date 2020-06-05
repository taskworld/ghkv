// @ts-check
const yargs = require('yargs')
const uuidv4 = require('uuid').v4
const { GhkvDataStore } = require('./lib')

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

    /**
     * @typedef {{ active?: { owner: string; expiresAt: string }, queue?: { owner: string }[] }} QueueDoc
     */

    /**
     * @template T
     * @param {import('./lib').GhkvDataReference<QueueDoc>} doc
     * @param {() => Promise<T>} [worker]
     * @returns {Promise<T>}
     */
    async function queue(doc, worker) {
      const toDateJSON = (t = Date.now()) => new Date(t).toJSON()

      // Waiting phase
      log('Waiting phase: Entered')
      for (;;) {
        const state = await doc.update(
          (data) => {
            if (!data) data = {}

            // If someone is using it but expired, pull them down
            if (data.active && toDateJSON() >= data.active.expiresAt) {
              delete data.active
            }

            // If someone is using it but, surprise surprise, happens to be me, well then!
            if (data.active && data.active.owner === id) {
              return data
            }

            // If no one is using it and there is a queue, put them on stage
            if (!data.active && data.queue && data.queue.length > 0) {
              const { owner } = data.queue.shift()
              data.active = { owner, expiresAt: toDateJSON(Date.now() + 60e3) }
            }

            // If still no one is using it, go on stage
            if (!data.active) {
              data.active = {
                owner: id,
                expiresAt: toDateJSON(Date.now() + 300e3),
              }
            }

            // If the consumer on stage is not me, wait in queue
            if (data.active.owner !== id) {
              if (!data.queue) {
                data.queue = []
              }
              // Only if I am not already on it tho
              if (!data.queue.some((item) => item.owner === id)) {
                data.queue.push({ owner: id })
              }
            }

            return data
          },
          { message: `Request resource usage by ${id}` }
        )

        if (state.active && state.active.owner === id) {
          log('Waiting phase: Ready')
          break
        } else {
          log('Waiting phase: Queued')
          await delay(15e3)
        }
      }

      // This is my turn now!!!
      let finished = false
      let lastTimeout
      log('Running phase: Entered')
      ;(async () => {
        while (!finished) {
          try {
            await doc.update(
              (data) => {
                if (!data) data = {}

                // If I still own this, extend the expiry time
                if (data.active && data.active.owner === id) {
                  data.active.expiresAt = toDateJSON(Date.now() + 300e3)
                }

                return data
              },
              { message: `Extend resource usage lease by ${id}` }
            )
            log('Running phase: Updated')
          } catch (error) {
            log('Running phase: Error updating', error)
          }
          if (finished) return
          const promise = delay(60e3)
          lastTimeout = promise.timeout
          await promise
        }
      })()

      try {
        const result = await worker()
        return result
      } finally {
        finished = true
        clearTimeout(lastTimeout)
        log('Finishing phase: Entered')

        await doc.update(
          (data) => {
            if (!data) data = {}

            // If I am on the stage, step down
            if (data.active && data.active.owner === id) {
              delete data.active
            }

            // If someone is waiting, put them on stage
            if (!data.active && data.queue && data.queue.length > 0) {
              const { owner } = data.queue.shift()
              data.active = { owner, expiresAt: toDateJSON(Date.now() + 60e3) }
            }

            return data
          },
          { message: `Finish resource usage by ${id}` }
        )
        log('Finishing phase: Finished')
      }
    }

    const store = createStore()
    await queue(store.doc('examples/distributed-queue'), async () => {
      for (let i = 1; i <= 100; i++) {
        log('Working: ' + i + '%')
        await delay(1000)
      }
    })
  })
  .parse()

const delay = (t) => {
  let timeout
  const promise = new Promise((resolve) => (timeout = setTimeout(resolve, t)))
  return Object.assign(promise, { timeout })
}
