import type { SeedFileRecord, SeedSource } from '../types/app'

const DATABASE_NAME = 'biome.web.seeds'
const DATABASE_VERSION = 1
const SEED_STORE = 'seeds'
const THUMBNAIL_WIDTH_PX = 600

type StoredSeedSource = Exclude<SeedSource, 'default'>

type StoredSeed = SeedFileRecord & {
  id: string
  source: StoredSeedSource
  base64: string
}

let databasePromise: Promise<IDBDatabase> | null = null
const thumbnailCache = new Map<string, Promise<string>>()

function seedId(filename: string, source: StoredSeedSource): string {
  return `${source}:${filename}`
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(SEED_STORE)) {
        database.createObjectStore(SEED_STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Failed to open the browser seed database'))
    request.onblocked = () => reject(new Error('The browser seed database is blocked by another tab'))
  })

  return databasePromise
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Browser seed database request failed'))
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Browser seed database transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Browser seed database transaction was aborted'))
  })
}

async function getStoredSeed(filename: string, source: StoredSeedSource): Promise<StoredSeed | undefined> {
  const database = await openDatabase()
  const transaction = database.transaction(SEED_STORE, 'readonly')
  return requestResult(transaction.objectStore(SEED_STORE).get(seedId(filename, source))) as Promise<
    StoredSeed | undefined
  >
}

async function putStoredSeed(filename: string, source: StoredSeedSource, base64: string): Promise<SeedFileRecord> {
  if (!filename) throw new Error('Seed filename cannot be empty')
  if (!base64) throw new Error(`Seed image ${filename} is empty`)

  const record: StoredSeed = {
    id: seedId(filename, source),
    filename,
    source,
    modifiedAt: Date.now(),
    base64
  }
  const database = await openDatabase()
  const transaction = database.transaction(SEED_STORE, 'readwrite')
  const complete = transactionComplete(transaction)
  transaction.objectStore(SEED_STORE).put(record)
  await complete
  thumbnailCache.delete(filename)
  return { filename: record.filename, source: record.source, modifiedAt: record.modifiedAt }
}

export async function listStoredSeeds(): Promise<SeedFileRecord[]> {
  const database = await openDatabase()
  const transaction = database.transaction(SEED_STORE, 'readonly')
  const records = (await requestResult(transaction.objectStore(SEED_STORE).getAll())) as StoredSeed[]
  return records.map(({ filename, source, modifiedAt }) => ({ filename, source, modifiedAt }))
}

export async function getStoredSeedBase64(filename: string): Promise<string | null> {
  // Match the desktop resolution order when an uploaded and generated scene
  // happen to share a filename.
  const uploaded = await getStoredSeed(filename, 'uploaded')
  if (uploaded) return uploaded.base64
  const generated = await getStoredSeed(filename, 'generated')
  return generated?.base64 ?? null
}

export function uploadStoredSeed(filename: string, base64: string): Promise<SeedFileRecord> {
  return putStoredSeed(filename, 'uploaded', base64)
}

export function saveGeneratedSeed(base64: string): Promise<SeedFileRecord> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const randomSuffix = Math.random().toString(36).slice(2, 8)
  return putStoredSeed(`generated_${timestamp}_${randomSuffix}.jpg`, 'generated', base64)
}

export async function deleteStoredSeed(filename: string, source: SeedSource): Promise<void> {
  if (source === 'default') return
  const database = await openDatabase()
  const transaction = database.transaction(SEED_STORE, 'readwrite')
  const complete = transactionComplete(transaction)
  transaction.objectStore(SEED_STORE).delete(seedId(filename, source))
  await complete
  thumbnailCache.delete(filename)
}

function mimeTypeForFilename(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase()
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  if (extension === 'bmp') return 'image/bmp'
  if (extension === 'avif') return 'image/avif'
  return 'image/jpeg'
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mimeType })
}

async function renderThumbnail(filename: string, base64: string): Promise<string> {
  const image = await createImageBitmap(base64ToBlob(base64, mimeTypeForFilename(filename)))
  try {
    if (!image.width || !image.height) throw new Error(`Seed image ${filename} has invalid dimensions`)
    const width = Math.min(THUMBNAIL_WIDTH_PX, image.width)
    const height = Math.max(1, Math.round((image.height * width) / image.width))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Failed to create a canvas for the seed thumbnail')
    context.drawImage(image, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', 0.85).split(',')[1]
  } finally {
    image.close()
  }
}

export function getSeedThumbnailBase64(filename: string, base64: string): Promise<string> {
  let thumbnail = thumbnailCache.get(filename)
  if (!thumbnail) {
    thumbnail = renderThumbnail(filename, base64)
    thumbnailCache.set(filename, thumbnail)
  }
  return thumbnail
}
