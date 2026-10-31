// In-memory change token for the library. Clients only compare it for inequality: a different value means
// "something changed, refetch". The boot stamp makes a server restart look like a change too.
const bootStamp = Date.now().toString(36);
let counter = 0;

export function bumpRevision() {
  counter++;
}

export function getRevision() {
  return `${bootStamp}.${counter}`;
}
