export async function instantiate(module, imports = {}) {
  const adaptedImports = {
    env: Object.assign(Object.create(globalThis), imports.env || {}, {
      abort(message, fileName, lineNumber, columnNumber) {
        // ~lib/builtins/abort(~lib/string/String | null?, ~lib/string/String | null?, u32?, u32?) => void
        message = __liftString(message >>> 0);
        fileName = __liftString(fileName >>> 0);
        lineNumber = lineNumber >>> 0;
        columnNumber = columnNumber >>> 0;
        (() => {
          // @external.js
          throw Error(`${message} in ${fileName}:${lineNumber}:${columnNumber}`);
        })();
      },
    }),
  };
  const { exports } = await WebAssembly.instantiate(module, adaptedImports);
  const memory = exports.memory || imports.env.memory;
  const adaptedExports = Object.setPrototypeOf({
    noa_abi_version() {
      // src/index/noa_abi_version() => u32
      return exports.noa_abi_version() >>> 0;
    },
    noa_init(sampleRate, maxBlockSize) {
      // src/index/noa_init(u32, u32) => u32
      return exports.noa_init(sampleRate, maxBlockSize) >>> 0;
    },
    noa_get_audio_in_ptr() {
      // src/index/noa_get_audio_in_ptr() => u32
      return exports.noa_get_audio_in_ptr() >>> 0;
    },
    noa_get_audio_out_ptr() {
      // src/index/noa_get_audio_out_ptr() => u32
      return exports.noa_get_audio_out_ptr() >>> 0;
    },
    noa_get_event_buf_ptr() {
      // src/index/noa_get_event_buf_ptr() => u32
      return exports.noa_get_event_buf_ptr() >>> 0;
    },
    noa_event_buf_capacity() {
      // src/index/noa_event_buf_capacity() => u32
      return exports.noa_event_buf_capacity() >>> 0;
    },
    noa_get_param_buf_ptr() {
      // src/index/noa_get_param_buf_ptr() => u32
      return exports.noa_get_param_buf_ptr() >>> 0;
    },
    noa_param_count() {
      // src/index/noa_param_count() => u32
      return exports.noa_param_count() >>> 0;
    },
    noa_state_size() {
      // src/index/noa_state_size() => u32
      return exports.noa_state_size() >>> 0;
    },
    noa_get_state(outPtr) {
      // src/index/noa_get_state(u32) => u32
      return exports.noa_get_state(outPtr) >>> 0;
    },
    noa_set_state(inPtr, nBytes) {
      // src/index/noa_set_state(u32, u32) => u32
      return exports.noa_set_state(inPtr, nBytes) >>> 0;
    },
  }, exports);
  function __liftString(pointer) {
    if (!pointer) return null;
    const
      end = pointer + new Uint32Array(memory.buffer)[pointer - 4 >>> 2] >>> 1,
      memoryU16 = new Uint16Array(memory.buffer);
    let
      start = pointer >>> 1,
      string = "";
    while (end - start > 1024) string += String.fromCharCode(...memoryU16.subarray(start, start += 1024));
    return string + String.fromCharCode(...memoryU16.subarray(start, end));
  }
  return adaptedExports;
}
