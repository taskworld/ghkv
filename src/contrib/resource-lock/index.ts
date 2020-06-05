import ObjectID from 'bson-objectid'
import delay from 'delay'
import { GhkvDataStore } from '../..'

export interface IResourceLock {
  acquire: () => Promise<IAcquiredLock>
}

export interface IAcquiredLock {
  release: () => Promise<void>
}

type QueueDoc = {
  active?: { owner: string; expiresAt: string }
  queue?: { owner: string }[]
}

export class GhkvResourceLock implements IResourceLock {
  constructor(private store: GhkvDataStore, public path: string) {}
  log = (format: string, ...args: any[]) =>
    console.log(
      `[${new Date().toJSON()}] [GhkvResourceLock] ${format}`,
      ...args
    )

  async acquire(acquirerIdSuffix: string = ''): Promise<IAcquiredLock> {
    const doc = this.store.doc<QueueDoc>(this.path)
    const resourceId = this.path
    const id =
      ObjectID.generate() + (acquirerIdSuffix ? '-' : '') + acquirerIdSuffix
    const log = (format: string, ...args: any[]) => {
      this.log(format, ...args)
    }
    const toDateJSON = (t = Date.now()) => new Date(t).toJSON()

    log('Waiting phase: Entered')
    let waitingMessage = ''
    const startTime = Date.now()
    for (;;) {
      const state = await doc.update(
        (data) => {
          if (!data) {
            data = {}
          }

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
            const { owner } = data.queue.shift()!
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
        { message: `Request usage of ${resourceId} by ${id}` }
      )

      if (state.active && state.active.owner === id) {
        log('Waiting phase: Ready')
        break
      } else {
        const elapsed = Math.floor((Date.now() - startTime) / 60e3)
        const position =
          (state.queue || []).findIndex((item) => item.owner === id) + 1
        const message =
          `The resource is currently being used by "${state.active?.owner}".` +
          (position === 1
            ? ' We are next.'
            : ' We are in position ' + position + ' inside the queue.') +
          ` Been waiting for ${
            elapsed === 1 ? '1 minute' : elapsed + ' minutes.'
          }`
        if (message !== waitingMessage) {
          waitingMessage = message
          log('Waiting phase: Queued -- ' + message)
        }
        await delay(15e3)
      }
    }

    // This is my turn now!!!
    let finished = false
    let lastDelay: ReturnType<typeof delay>
    log('Running phase: Entered')
    ;(async () => {
      // eslint-disable-next-line no-unmodified-loop-condition
      while (!finished) {
        try {
          await doc.update(
            (data) => {
              if (!data) {
                data = {}
              }

              // If I still own this, extend the expiry time
              if (data.active && data.active.owner === id) {
                data.active.expiresAt = toDateJSON(Date.now() + 300e3)
              }

              return data
            },
            { message: `Extend usage lease of ${resourceId} by ${id}` }
          )
        } catch (error) {
          log('Running phase: Error updating', error)
        }
        if (finished) {
          return
        }
        const delayInstance = delay(120e3)
        lastDelay = delayInstance
        await delayInstance
      }
    })()

    return {
      release: async () => {
        if (finished) {
          return
        }

        finished = true

        if (lastDelay) {
          lastDelay.clear()
        }
        log('Finishing phase: Entered')

        await doc.update(
          (data) => {
            if (!data) {
              data = {}
            }

            // If I am on the stage, step down
            if (data.active && data.active.owner === id) {
              delete data.active
            }

            // If someone is waiting, put them on stage
            if (!data.active && data.queue && data.queue.length > 0) {
              const { owner } = data.queue.shift()!
              data.active = { owner, expiresAt: toDateJSON(Date.now() + 60e3) }
            }

            return data
          },
          { message: `Finish usage of ${resourceId} by ${id}` }
        )
        log('Finishing phase: Finished')
      },
    }
  }
}
