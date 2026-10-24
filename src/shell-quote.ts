/** `shell: true` hands the argv to a shell as one string with no quoting of its
 *  own, so anything a shell would split has to be quoted here - a home directory
 *  with a space in it is otherwise read as two arguments. */
export function shellQuote(arg: string): string {
  if (process.platform === 'win32') return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}
