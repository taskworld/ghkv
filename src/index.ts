import { Octokit } from '@octokit/rest'

export type GhkvCreateOptions = {
  accessToken: string
  owner: string
  repo: string
  ref?: string
}

export type GhkvDataReference<T> = {
  get: () => Promise<T | null>
  set: (data: T, options?: { message?: string }) => Promise<void>
  update: (
    updater: (data: T | null) => T,
    options?: { message?: string }
  ) => Promise<T>
}

export class GhkvDataStore {
  private cache = new Map<string, GhkvDataReference<any>>()
  private owner: string
  private repo: string
  private ref?: string
  private octokit: Octokit

  constructor(options: GhkvCreateOptions) {
    this.octokit = new Octokit({ auth: options.accessToken })
    this.owner = options.owner
    this.repo = options.repo
    this.ref = options.ref
  }
  doc<T>(key: string): GhkvDataReference<T> {
    const { owner, repo, ref } = this
    let doc = this.cache.get(key)
    if (!doc) {
      const path = key + '.json'
      type Cache = { existing?: { sha: string; content?: string } }
      let cache: Cache | null
      const ensureCache = async ({ renew = false } = {}) => {
        if (!cache || renew) {
          try {
            const { data } = await this.octokit.repos.getContents({
              owner,
              repo,
              path,
              ref,
            })
            if (Array.isArray(data)) {
              throw new Error(`Did not expect "${path}" to be a directory.`)
            }
            cache = { existing: data }
          } catch (error) {
            if (error.status === 404) {
              cache = {}
            } else {
              throw error
            }
          }
        }
        return cache
      }
      const newDoc: GhkvDataReference<T> = {
        get: async () => {
          const cache = await ensureCache({ renew: true })
          return parseDoc(cache)
        },
        set: async (
          v,
          { message = `set(${key}) @ ${new Date().toJSON()}` } = {}
        ) => {
          const cache = await ensureCache()
          const newContent = Buffer.from(JSON.stringify(v, null, 2)).toString(
            'base64'
          )
          const { data: result } = await this.octokit.repos.createOrUpdateFile({
            sha: cache.existing?.sha,
            owner,
            repo,
            ref,
            path,
            content: newContent,
            message: message,
          })
          cache.existing = { sha: result.content.sha, content: newContent }
        },
        update: async (
          updater: (data: T | null) => T,
          { message = `set(${key}) @ ${new Date().toJSON()}` } = {}
        ) => {
          const cache = await ensureCache()
          const newData = updater(parseDoc(cache))
          await newDoc.set(newData, { message })
          return newData
        },
      }
      doc = newDoc
    }
    return doc
  }
}

function parseDoc(cache: {
  existing?: { sha: string; content?: string | undefined } | undefined
}): any {
  return cache.existing
    ? JSON.parse(Buffer.from(cache.existing.content!, 'base64').toString())
    : null
}
