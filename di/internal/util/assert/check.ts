export function check(validation: boolean, error: string | Error) {
  if (!validation) {
    if (typeof error === 'string') {
      throw error
    }

    throw new Error(error as unknown as string)
  }
}
