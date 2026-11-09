// Expo's Metro config, in a pnpm workspace: watch the workspace root so packages resolve
// to their TypeScript sources.
const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

const root = path.resolve(__dirname, '../..')
const config = getDefaultConfig(__dirname)
config.watchFolders = [root]
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules'), path.resolve(root, 'node_modules')]
module.exports = config
