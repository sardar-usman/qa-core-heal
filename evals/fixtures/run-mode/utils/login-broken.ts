/** A login helper that fails outright (bad credentials, service down...). */
export async function login(): Promise<void> {
  throw new Error('bad credentials');
}
