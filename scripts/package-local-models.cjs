const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = async (context) => {
  const root = path.resolve(__dirname, '..'),
    destination = path.resolve(context.appOutDir, 'resources', 'local-models');
  if (!destination.startsWith(path.join(root, 'release') + path.sep))
    throw Error('模型打包路径必须在本工程release内');
  async function copy(source, target) {
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) throw Error('模型资源不允许符号链接');
    if (stat.isDirectory()) {
      await fs.mkdir(target, { recursive: true });
      for (const name of await fs.readdir(source))
        await copy(path.join(source, name), path.join(target, name));
    } else {
      try {
        await fs.link(source, target);
      } catch (e) {
        if (e.code === 'EEXIST') return;
        if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(e.code)) throw e;
        await fs.copyFile(source, target);
      }
    }
  }
  for (const name of ['sensevoice', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', 'manifest.json'])
    await copy(path.join(root, 'vendor', 'local-models', name), path.join(destination, name));
};
