import { Octokit } from '@octokit/rest'
import Debug from 'debug'

const debug = Debug('ghkv')

export type GhkvCreateOptions = {
  accessToken: string
  owner: string
  repo: string
  branch?: string
  readOnly?: boolean
}

export type GhkvDataReference<T> = {
  get: () => Promise<T | undefined>
  set: (data: T, options?: { message?: string }) => Promise<T>
  update: (
    updater: (data: T | undefined) => T,
    options?: { message?: string }
  ) => Promise<T>
}

export class GhkvDataStore {
  private cache = new Map<string, GhkvDataReference<any>>()
  private owner: string
  private repo: string
  private branch?: string
  private octokit: Octokit
  private readOnly = false
  private connectivityPromise?: Promise<unknown>

  constructor(options: GhkvCreateOptions) {
    this.octokit = new Octokit({
      auth: options.accessToken || process.env.GITHUB_TOKEN,
    })
    this.owner = options.owner
    this.repo = options.repo
    this.branch = options.branch
    this.readOnly = options.readOnly ?? false
  }
  private async ensureConnectivity() {
    if (!this.connectivityPromise) {
      const { owner, repo, branch } = this
      this.connectivityPromise = (async () => {
        const {
          data: { permissions: { push } = {} },
        } = await this.octokit.repos.get({ owner, repo })
        debug('Repo loaded, push permission is', push)
        if (!push && !this.readOnly) {
          throw new Error(
            `You don’t have a permission to push to the repository "${owner}/${repo}" and the readOnly option has not been set.`
          )
        }
        if (branch) {
          await this.octokit.repos.getBranch({
            owner,
            repo,
            branch,
          })
          debug('Branch loaded, push permission is', push)
        }
      })()
    }
    await this.connectivityPromise.catch(
      decorateErrorWithMessage(`ensureConnectivity`)
    )
  }
  doc<T>(key: string): GhkvDataReference<T> {
    const { owner, repo, branch } = this
    let doc = this.cache.get(key)
    if (!doc) {
      const path = key + '.json'
      type Cache = {
        existing?: { sha: string; content?: string; expires: number }
      }
      let cache: Cache | null
      let cacheLoadPromise: Promise<void> | undefined
      const ensureCache = async ({ renew = false } = {}) => {
        if (
          !cache ||
          renew ||
          (cache.existing && Date.now() > cache.existing.expires)
        ) {
          if (cacheLoadPromise) {
            await cacheLoadPromise
          } else {
            cacheLoadPromise = (async () => {
              try {
                debug('Requesting contents for', path)
                const { data } = await this.octokit.repos
                  .getContents({
                    owner,
                    repo,
                    path,
                    ref: branch,
                  })
                  .catch(decorateErrorWithMessage(`getContents`))
                if (Array.isArray(data)) {
                  throw new Error(`Did not expect "${path}" to be a directory.`)
                }
                debug('Fetched contents for', path, data.sha)
                cache = {
                  existing: {
                    sha: data.sha,
                    content: data.content,
                    expires: Date.now() + 5e3,
                  },
                }
              } catch (error) {
                if (error.status === 404) {
                  debug('Not found', path)
                  cache = {}
                } else {
                  throw error
                }
              }
            })()
            try {
              await cacheLoadPromise
            } finally {
              cacheLoadPromise = undefined
            }
          }
        }
        if (!cache) {
          throw new Error('Internal error: Cache data not found despite loaded')
        }
        return cache
      }
      const updateDoc = async (
        updater: (data: T | undefined) => T,
        message: string
      ) => {
        let attempt = 0
        const retryDelays = [0, 1000, 2000, 5000, 10000]
        for (;;) {
          try {
            const cache = await ensureCache({ renew: attempt > 0 })
            const newData = updater(parseDoc(cache))
            const newContent = Buffer.from(
              JSON.stringify(newData, null, 2)
            ).toString('base64')
            if (
              String(newContent).trim() ===
              String(cache.existing?.content).trim()
            ) {
              return newData
            }
            const { data: result } = await this.octokit.repos
              .createOrUpdateFile({
                sha: cache.existing?.sha,
                owner,
                repo,
                branch,
                path,
                content: newContent,
                message: message,
              })
              .catch(decorateErrorWithMessage('createOrUpdateFile'))
            debug('Updated', path, result.content.sha)
            cache.existing = {
              sha: result.content.sha,
              content: newContent,
              expires: Date.now() + 5e3,
            }
            return newData
          } catch (error) {
            if ((error.status === 409 || error.status === 422) && attempt < 5) {
              debug('Update error', path, error.status)
              const retryDelay = retryDelays[attempt++]
              if (retryDelay != null) {
                debug('Retry updating %s in %s ms', path, retryDelay)
                await new Promise((resolve) => setTimeout(resolve, retryDelay))
                continue
              }
            }
            throw error
          }
        }
      }
      const newDoc: GhkvDataReference<T> = {
        get: async () => {
          await this.ensureConnectivity()
          const cache = await ensureCache({ renew: true }).catch(
            decorateErrorWithMessage(`get(${key})`)
          )
          return parseDoc(cache)
        },
        set: async (
          v,
          { message = `set(${key}) @ ${new Date().toJSON()}` } = {}
        ) => {
          await this.ensureConnectivity()
          return updateDoc(() => v, message).catch(
            decorateErrorWithMessage(`set(${key})`)
          )
        },
        update: async (
          updater: (data: T | undefined) => T,
          { message = `update(${key}) @ ${new Date().toJSON()}` } = {}
        ) => {
          await this.ensureConnectivity()
          return updateDoc(updater, message).catch(
            decorateErrorWithMessage(`update(${key})`)
          )
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
    : undefined
}

function decorateErrorWithMessage(text: string) {
  return (error: any) => {
    if (typeof error?.message === 'string') {
      error.message = `${text} > ${error.message}`
    }
    throw error
  }
}
