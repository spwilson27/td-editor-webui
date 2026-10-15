// Array.prototype.at (ES2022) is available in the test runtimes; the project lib target predates it.
interface Array<T> { at(index: number): T | undefined }
