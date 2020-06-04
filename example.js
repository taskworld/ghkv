const yargs = require('yargs')
const { GhkvDataStore } = require('./lib')

function getStore() {
  const store = new GhkvDataStore({
    owner: 'taskworld',
    repo: 'ghkv',
    branch: 'datastore',
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
      const store = getStore()
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
      const store = getStore()
      const doc = store.doc(args.key)
      const result = await doc.set(JSON.parse(args.value))
      console.log(JSON.stringify(result, null, 2))
    }
  )
  .command('test:counter', 'Add to a shared counter', {}, async (args) => {
    const store = getStore()
    const doc = store.doc('examples/counter')
    const result = await doc.update((item = {}) => {
      return { ...item, count: (+item.count || 0) + 1 }
    })
    console.log(JSON.stringify(result, null, 2))
  })
  .parse()
