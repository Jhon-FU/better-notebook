export function validNote(html = 'selected note') {
  return {
    version: 1, paper: 'lines', images: {},
    items: [{ id: 1, type: 'text', html, x: 20, y: 30, w: 240, z: 1, rot: 0, fontSize: 18, align: 'left' }],
  };
}

export function fileHandle(data, name = 'selected.json') {
  let contents = typeof data === 'string' ? data : JSON.stringify(data);
  let writes = 0, reads = 0;
  return {
    get contents() { return contents; },
    get writes() { return writes; },
    get reads() { return reads; },
    handle: {
      name,
      queryPermission: async () => 'granted',
      getFile: async () => {
        reads++;
        return { text: async () => contents };
      },
      createWritable: async () => ({
        write: async body => { writes++; contents = body; },
        close: async () => {},
      }),
    },
  };
}

export function installPicker(app, selected) {
  app.window.showOpenFilePicker = async () => [selected.handle];
  app.context.rememberedHandles = [];
  app.run('idbOpen=async()=>({}); idbSet=async(key,handle)=>rememberedHandles.push(handle)');
}
