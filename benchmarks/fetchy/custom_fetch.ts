import { baseURL } from './config.js'

export async function customFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${baseURL}${url}`, options)
  return (await response.json()) as T
}
