# ghkv

A key-value store for your CI/CD workflows. Backed by GitHub API.

## API

```js
const { GhkvDataStore } = require('ghkv')
```

### `const store = new GhkvDataStore(options)`

- `options.accessToken` An access token used to access the GitHub API
- `options.owner` Owner of the repository
- `options.repo` Repository name
- `options.branch` (Optional) Branch used to store data, defaults to the default branch

### `const doc = store.doc<T>(key)`

Retrieves a reference to the document by key.

### `doc.get(): Promise<T | undefined>`

Retrieves the current document data.

### `doc.update(updater, options)`

Updates the document.

- `updater: (data: T | undefined) => T`
  This function should return an updated document, given the original document.
  Note that it may be called more than once in case of a conflict due to concurrent updates.
- `options.message` (Optional) The commit message.

### `doc.set(data, options)`

Updates the document.

- `data` Data to set. In case of concurrent updates, last write wins.
- `options.message` (Optional) The commit message.
