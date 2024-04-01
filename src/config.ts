import * as path from 'path'
import * as fs from 'fs'
import { debug, exportVariable, info } from '@actions/core'
import * as artifact from '@actions/artifact'
import { type UploadResponse } from '@actions/artifact'
import { executePiper } from './execute'
import { downloadFileFromGitHub, getHost } from './github'
import {
  ENTERPRISE_DEFAULTS_FILENAME,
  ENTERPRISE_STAGE_CONFIG_FILENAME,
  // getEnterpriseDefaultsUrl,
  // getEnterpriseStageConfigUrl,
  getEnterpriseConfigUrl
} from './enterprise'
import { internalActionVariables } from './piper'

export const CONFIG_DIR = '.pipeline'
export const ARTIFACT_NAME = 'Pipeline defaults'

export async function getDefaultConfig (server: string, apiURL: string, version: string, token: string, owner: string, repository: string, customDefaultsPaths: string): Promise<number> {
  if (fs.existsSync(path.join(CONFIG_DIR, ENTERPRISE_DEFAULTS_FILENAME))) {
    info('Defaults are present')
    if (process.env.defaultsFlags !== undefined) {
      debug(`Defaults flags: ${process.env.defaultsFlags}`)
    } else {
      debug('But no defaults flags available in the environment!')
    }
    return await Promise.resolve(0)
  }

  try {
    await restoreDefaultConfig()
    info('Defaults restored from artifact')
    return await Promise.resolve(0)
  } catch (err: unknown) {
    // throws an error with message containing 'Unable to find' if artifact does not exist
    if (err instanceof Error && !err.message.includes('Unable to find')) throw err
    // continue with downloading defaults and upload as artifact
    info('Downloading defaults')
    await downloadDefaultConfig(server, apiURL, version, token, owner, repository, customDefaultsPaths)
    return await Promise.resolve(0)
  }
}

export async function downloadDefaultConfig (server: string, apiURL: string, version: string, token: string, owner: string, repository: string, customDefaultsPaths: string): Promise<UploadResponse> {
  let defaultsPaths: string[] = []

  const enterpriseDefaultsURL = await getEnterpriseConfigUrl('DefaultConfig', apiURL, version, token, owner, repository)
  if (enterpriseDefaultsURL !== '') {
    defaultsPaths = defaultsPaths.concat([enterpriseDefaultsURL])
  }
  info(`enterpriseDefaultsURL: ${enterpriseDefaultsURL}`)

  const customDefaultsPathsArray = customDefaultsPaths !== '' ? customDefaultsPaths.split(',') : []
  defaultsPaths = defaultsPaths.concat(customDefaultsPathsArray)
  const defaultsPathsArgs = defaultsPaths.map((url) => ['--defaultsFile', url]).flat()
  info(`defaultsPathsArgs: ${defaultsPathsArgs}`)

  const piperPath = internalActionVariables.piperBinPath
  if (piperPath === undefined) {
    throw new Error('Can\'t download default config: piperPath not defined!')
  }
  const flags: string[] = []
  flags.push(...defaultsPathsArgs)
  flags.push('--gitHubTokens', `${getHost(server)}:${token}`)
  info(`flags: ${flags}`)
  const piperExec = await executePiper('getDefaults', flags)

  let defaultConfigs = JSON.parse(piperExec.output)
  if (customDefaultsPathsArray.length === 0) {
    defaultConfigs = [defaultConfigs]
  }
  info(`defaultConfigs: ${defaultConfigs[0]}`)

  for (const defaultConfig of defaultConfigs) {
    // const configPath = path.join(CONFIG_DIR, path.basename(defaultConfig.filepath))
    // fs.writeFileSync(configPath, defaultConfig.content)
    // defaultsPaths.push(configPath)
    info(`defaultConfig filepath: ${defaultConfig.filepath}`)
    info(`defaultConfig content: ${defaultConfig.content}`)
  }

  const savedDefaultsPaths = saveDefaultConfigs(defaultConfigs)
  info(`savedDefaultsPaths: ${savedDefaultsPaths}`)
  info(`defaultsFlags: ${generateDefaultConfigFlags(savedDefaultsPaths)}`)
  const uploadResponse = await uploadDefaultConfigArtifact(savedDefaultsPaths)
  exportVariable('defaultsFlags', generateDefaultConfigFlags(savedDefaultsPaths))
  return uploadResponse
}

// TODO configuration should be strictly typed
export function saveDefaultConfigs (defaultConfigs: any[]): string[] {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR)
  }

  const defaultsPaths = []
  try {
    for (const defaultConfig of defaultConfigs) {
      const configPath = path.join(CONFIG_DIR, path.basename(defaultConfig.filepath))
      fs.writeFileSync(configPath, defaultConfig.content)
      defaultsPaths.push(configPath)
    }

    return defaultsPaths
  } catch (err) {
    throw new Error(`Could not retrieve default configuration: ${err as string}`)
  }
}

export async function downloadStageConfig (server: string, apiURL: string, version: string, token: string, owner: string, repository: string): Promise<void> {
    const stageConfigURL = await getEnterpriseConfigUrl('StageConfig', apiURL, version, token, owner, repository)
    info(`stageConfigURL: ${stageConfigURL}`)
    if (stageConfigURL === '') {
      throw new Error('Can\'t download stage config: failed to get URL!')
    }
  
    const piperPath = internalActionVariables.piperBinPath
    if (piperPath === undefined) {
      throw new Error('Can\'t download stage config: piperPath not defined!')
    }
    const flags: string[] = ['--useV1']
    flags.push('--defaultsFile', stageConfigURL)
    flags.push('--gitHubTokens', `${getHost(server)}:${token}`)
    info(`flags: ${flags}`)
    const piperExec = await executePiper('getDefaults', flags)
  
    let stageConfig = JSON.parse(piperExec.output)
    info(`stageConfig filepath: ${stageConfig.filepath}`)
    info(`stageConfig content: ${stageConfig.content}`)

    fs.writeFileSync(path.join(CONFIG_DIR, ENTERPRISE_STAGE_CONFIG_FILENAME), stageConfig.content)
}

export async function createCheckIfStepActiveMaps (server: string, apiURL: string, version: string, token: string, owner: string, repository: string): Promise<void> {
  info('creating maps with active stages and steps with checkIfStepActive')

  await downloadStageConfig(server, apiURL, version, token, owner, repository)
    .then(async () => await checkIfStepActive('_', '_', true))
    .catch(err => {
      info(`checkIfStepActive failed: ${err as string}`)
    })
}

export async function checkIfStepActive (stepName: string, stageName: string, outputMaps: boolean): Promise<number> {
  const flags: string[] = []
  flags.push('--stageConfig', path.join(CONFIG_DIR, ENTERPRISE_STAGE_CONFIG_FILENAME))
  if (outputMaps) {
    flags.push('--stageOutputFile', '.pipeline/stage_out.json')
    flags.push('--stepOutputFile', '.pipeline/step_out.json')
  }
  flags.push('--stage', stageName)
  flags.push('--step', stepName)

  const result = await executePiper('checkIfStepActive', flags)
  return result.exitCode
}

export async function restoreDefaultConfig (): Promise<void> {
  const artifactClient = artifact.create()
  const tempDir = path.join(CONFIG_DIR, 'defaults_temp')
  // throws an error with message containing 'Unable to find' if artifact does not exist
  await artifactClient.downloadArtifact(ARTIFACT_NAME, tempDir)

  const defaultsPaths: string[] = []
  try {
    const defaultsOrder = JSON.parse(fs.readFileSync(path.join(tempDir, 'defaults_order.json'), 'utf8'))
    defaultsOrder.forEach((defaultsFileName: string) => {
      const artifactPath = path.join(tempDir, defaultsFileName)
      const newPath = path.join(CONFIG_DIR, defaultsFileName)
      debug(`Moving ${artifactPath} to ${newPath}`)
      fs.renameSync(artifactPath, newPath)
      defaultsPaths.push(newPath)
    })
  } catch (err) {
    throw new Error(`Can't restore defaults: ${err as string}`)
  }

  exportVariable('defaultsFlags', generateDefaultConfigFlags(defaultsPaths))
  await Promise.resolve()
}

export async function uploadDefaultConfigArtifact (defaultsPaths: string[]): Promise<UploadResponse> {
  debug('uploading defaults as artifact')

  // order of (custom) defaults is important, so preserve it for when artifact is downloaded in another stage
  const orderedDefaultsPath = path.join(CONFIG_DIR, 'defaults_order.json')
  info(`orderedDefaultsPath: ${orderedDefaultsPath}`)
  const defaultsFileNames = defaultsPaths.map((filePath) => path.basename(filePath))
  info(`defaultsFileNames: ${defaultsFileNames}`)
  fs.writeFileSync(orderedDefaultsPath, JSON.stringify(defaultsFileNames))

  const artifactFiles = [...defaultsPaths, orderedDefaultsPath]
  info(`uploading files ${JSON.stringify(artifactFiles)} in base directory ${CONFIG_DIR} to artifact with name ${ARTIFACT_NAME}`)

  const artifactClient = artifact.create()
  return await artifactClient.uploadArtifact(ARTIFACT_NAME, artifactFiles, CONFIG_DIR)
}

export function generateDefaultConfigFlags (paths: string[]): string[] {
  return paths.map((path) => ['--defaultConfig', path]).flat()
}

export async function readContextConfig (stepName: string, flags: string[]): Promise<any> {
  if (['version', 'help', 'getConfig'].includes(stepName)) {
    return {}
  }

  const stageName = process.env.GITHUB_JOB
  const piperPath = internalActionVariables.piperBinPath

  if (piperPath === undefined) {
    throw new Error('Can\'t get context config: piperPath not defined!')
  }
  if (stageName === undefined) {
    throw new Error('Can\'t get context config: stageName not defined!')
  }

  const getConfigFlags = ['--contextConfig', '--stageName', `${stageName}`, '--stepName', `${stepName}`]
  if (flags.includes('--customConfig')) {
    const flagIdx = flags.indexOf('--customConfig')
    const customConfigFlagValue = flags[flagIdx + 1]
    getConfigFlags.push('--customConfig', customConfigFlagValue)
  }

  const piperExec = await executePiper('getConfig', getConfigFlags)
  return JSON.parse(piperExec.output)
}
