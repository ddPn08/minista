import type { Loader as EsbuildLoader } from "esbuild"
import type { Options as MdxOptions } from "@mdx-js/esbuild"
import type { Config as SvgrOptions } from "@svgr/core"
import type { InlineConfig } from "vite"
import type { HTMLElement as NhpHTML } from "node-html-parser"

import fs from "fs-extra"
import path from "path"
import url from "url"
import pc from "picocolors"
import { Fragment } from "react"
import { build as esBuild } from "esbuild"
import mdx from "@mdx-js/esbuild"
import {
  build as viteBuild,
  defineConfig as defineViteConfig,
  mergeConfig as mergeViteConfig,
} from "vite"
import { parse } from "node-html-parser"
import mojigiri from "mojigiri"
import picomatch from "picomatch"

import type {
  MinistaResolveConfig,
  MinistaLocation,
  RootStaticContent,
  RootEsmContent,
  RootJsxContent,
  GlobalStaticData,
  GetGlobalStaticData,
  PageEsmContent,
  PageJsxContent,
  StaticData,
  StaticDataItem,
  GetStaticData,
  AliasArray,
  PartialModules,
  PartialString,
  CssOptions,
  EntryObject,
  AssetsTagObject,
} from "./types.js"

import { systemConfig } from "./system.js"
import { getFilePath } from "./path.js"
import {
  resolvePlugin,
  svgrPlugin,
  rawPlugin,
  partialHydrationPlugin,
} from "./esbuild.js"
import { resolveaAssetFileName } from "./vite.js"
import { renderHtml } from "./render.js"
import { slashEnd, reactStylesToString, getFilename } from "./utils.js"
import { cssModulePlugin } from "./css.js"

const __filename = url.fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ministaPkgUrl = path.resolve(__dirname + "/../package.json")
const ministaPkgUrlRelative = path.relative(".", ministaPkgUrl)
const ministaPkg = JSON.parse(fs.readFileSync(ministaPkgUrlRelative, "utf8"))
const userPkgPath = path.resolve("package.json")
const userPkgFilePath = path.relative(process.cwd(), userPkgPath)
const userPkg = JSON.parse(fs.readFileSync(userPkgFilePath, "utf8"))

const esbuildExternals = [
  ...Object.keys(ministaPkg.dependencies || {}),
  ...Object.keys(ministaPkg.devDependencies || {}),
  ...Object.keys(ministaPkg.peerDependencies || {}),
  ...Object.keys(userPkg.dependencies || {}),
  ...Object.keys(userPkg.devDependencies || {}),
  ...Object.keys(userPkg.peerDependencies || {}),
  "*.css",
  "*.scss",
  "*.sass",
  //"react",
  //"react/*",
  //"react-dom",
  //"react-dom/*",
  //"react-helmet",
  //"react-helmet/*",
]
const esbuildLoaders: { [key: string]: EsbuildLoader } = {
  ".jpg": "file",
  ".jpeg": "file",
  ".png": "file",
  ".gif": "file",
  ".webp": "file",
  ".avif": "file",
  ".eot": "file",
  ".woff": "file",
  ".woff2": "file",
}
const userPkgHasPreact = [
  ...Object.keys(userPkg.dependencies || {}),
  ...Object.keys(userPkg.devDependencies || {}),
].includes("preact")

export async function buildTempPages(
  entryPoints: string[],
  buildOptions: {
    outBase: string
    outDir: string
    alias: AliasArray
    mdxConfig: MdxOptions
    svgrOptions: SvgrOptions
    cssOptions: CssOptions
  }
) {
  await esBuild({
    entryPoints: entryPoints,
    outbase: buildOptions.outBase,
    outdir: buildOptions.outDir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    format: "esm",
    platform: "node",
    inject: [
      path.resolve(__dirname + "/../lib/shim-react.js"),
      path.resolve(__dirname + "/../lib/shim-fetch.js"),
    ],
    external: esbuildExternals,
    loader: esbuildLoaders,
    plugins: [
      resolvePlugin({ "react/jsx-runtime": "react/jsx-runtime.js" }),
      cssModulePlugin(buildOptions.cssOptions, buildOptions.alias),
      mdx(buildOptions.mdxConfig),
      svgrPlugin(buildOptions.svgrOptions),
      rawPlugin(buildOptions.alias),
      partialHydrationPlugin(buildOptions.alias),
    ],
  }).catch(() => process.exit(1))
}

export async function buildStaticPages({
  entryPoints,
  tempRootFilePath,
  outBase,
  outDir,
  assetsTagArray,
  showLog,
}: {
  entryPoints: string[]
  tempRootFilePath: string
  outBase: string
  outDir: string
  assetsTagArray: AssetsTagObject[]
  showLog: boolean
}) {
  const rootStaticContent = await buildRootEsmContent(tempRootFilePath)
  const winOutBase = outBase.replaceAll("/", "\\")
  await Promise.all(
    entryPoints.map(async (entryPoint) => {
      const extname = path.extname(entryPoint)
      const basename = path.basename(entryPoint, extname)
      const dirname = path
        .dirname(entryPoint)
        .replace(outBase, outDir)
        .replace(winOutBase, outDir)
      const filename = path.join(dirname, basename + ".html")

      await buildStaticPage({
        entryPoint: entryPoint,
        outFile: filename,
        rootStaticContent: rootStaticContent,
        assetsTagArray: assetsTagArray,
        outDir: outDir,
        showLog: showLog,
      })
    })
  )
}

export async function buildRootEsmContent(tempRootFilePath: string) {
  const defaultRootEsmContent = {
    component: Fragment,
    staticData: { props: {} },
  }
  if (!tempRootFilePath) {
    return defaultRootEsmContent
  } else {
    const targetFilePath = url.pathToFileURL(tempRootFilePath).href
    const rootEsmContent: RootEsmContent = await import(targetFilePath)
    const rootJsxContent: RootJsxContent = rootEsmContent.default
      ? rootEsmContent.default
      : Fragment

    const staticData: GlobalStaticData = rootEsmContent.getStaticData
      ? await buildGlobalStaticData(rootEsmContent.getStaticData)
      : { props: {} }

    return { component: rootJsxContent, staticData: staticData }
  }
}

export async function buildGlobalStaticData(
  getGlobalStaticData: GetGlobalStaticData
) {
  const response = await getGlobalStaticData()
  return response
}

export async function buildStaticPage({
  entryPoint,
  outFile,
  rootStaticContent,
  assetsTagArray,
  outDir,
  showLog,
}: {
  entryPoint: string
  outFile: string
  rootStaticContent: RootStaticContent
  assetsTagArray: AssetsTagObject[]
  outDir: string
  showLog: boolean
}) {
  const targetFilePath = url.pathToFileURL(entryPoint).href
  const pageEsmContent: PageEsmContent = await import(targetFilePath)
  const pageJsxContent: PageJsxContent = pageEsmContent.default
  const frontmatter = pageEsmContent.frontmatter
    ? pageEsmContent.frontmatter
    : undefined
  const defaultStaticDataItem = { props: {}, paths: {} }

  const staticData: StaticData = pageEsmContent.getStaticData
    ? await buildStaticData(pageEsmContent.getStaticData)
    : undefined

  if (!staticData) {
    const staticDataItem = defaultStaticDataItem
    return await buildHtmlPage({
      pageJsxContent: pageJsxContent,
      staticDataItem: staticDataItem,
      routePath: outFile,
      rootStaticContent: rootStaticContent,
      assetsTagArray: assetsTagArray,
      frontmatter: frontmatter,
      outDir: outDir,
      showLog: showLog,
    })
  }

  if ("props" in staticData && "paths" in staticData === false) {
    const staticDataItem = { ...defaultStaticDataItem, ...staticData }
    return await buildHtmlPage({
      pageJsxContent: pageJsxContent,
      staticDataItem: staticDataItem,
      routePath: outFile,
      rootStaticContent: rootStaticContent,
      assetsTagArray: assetsTagArray,
      frontmatter: frontmatter,
      outDir: outDir,
      showLog: showLog,
    })
  }

  if ("paths" in staticData) {
    const staticDataItem = { ...defaultStaticDataItem, ...staticData }

    let fixedOutfile = outFile
    for await (const [key, value] of Object.entries(staticDataItem.paths)) {
      const reg = new RegExp("\\[" + key + "\\]", "g")
      fixedOutfile = fixedOutfile.replace(reg, `${value}`)
    }

    return await buildHtmlPage({
      pageJsxContent: pageJsxContent,
      staticDataItem: staticDataItem,
      routePath: fixedOutfile,
      rootStaticContent: rootStaticContent,
      assetsTagArray: assetsTagArray,
      frontmatter: frontmatter,
      outDir: outDir,
      showLog: showLog,
    })
  }

  if (Array.isArray(staticData) && staticData.length > 0) {
    const entryPoints = staticData

    await Promise.all(
      entryPoints.map(async (entryPoint) => {
        const staticDataItem = { ...defaultStaticDataItem, ...entryPoint }

        let fixedOutfile = outFile
        for await (const [key, value] of Object.entries(staticDataItem.paths)) {
          const reg = new RegExp("\\[" + key + "\\]", "g")
          fixedOutfile = fixedOutfile.replace(reg, `${value}`)
        }

        return await buildHtmlPage({
          pageJsxContent: pageJsxContent,
          staticDataItem: staticDataItem,
          routePath: fixedOutfile,
          rootStaticContent: rootStaticContent,
          assetsTagArray: assetsTagArray,
          frontmatter: frontmatter,
          outDir: outDir,
          showLog: showLog,
        })
      })
    )
  }
}

export async function buildStaticData(getStaticData: GetStaticData) {
  const response = await getStaticData()
  return response
}

export async function buildHtmlPage({
  pageJsxContent,
  staticDataItem,
  routePath,
  rootStaticContent,
  assetsTagArray,
  frontmatter,
  outDir,
  showLog,
}: {
  pageJsxContent: PageJsxContent
  staticDataItem: StaticDataItem
  routePath: string
  rootStaticContent: RootStaticContent
  assetsTagArray: AssetsTagObject[]
  frontmatter: any
  outDir: string
  showLog: boolean
}) {
  if (frontmatter?.draft) {
    return
  }

  const RootComponent: any = rootStaticContent.component
  const globalStaticData = rootStaticContent.staticData
  const PageComponent: any = pageJsxContent
  const staticProps = staticDataItem.props

  const reg1 = new RegExp(`^${outDir}|index.html`, "g")
  const reg2 = new RegExp(`.html`, "g")
  const pathname = routePath
    .replace(reg1, "")
    .replace(reg2, "")
    .replaceAll("\\", "/")
  const location: MinistaLocation = { pathname: pathname }

  const RenderComponent = () => {
    if (RootComponent === Fragment) {
      return (
        <Fragment>
          {(() => {
            if (PageComponent === Fragment) {
              return <Fragment />
            } else {
              return (
                <PageComponent
                  {...globalStaticData?.props}
                  {...staticProps}
                  frontmatter={frontmatter}
                  location={location}
                />
              )
            }
          })()}
        </Fragment>
      )
    } else {
      return (
        <RootComponent
          {...globalStaticData?.props}
          {...staticProps}
          frontmatter={frontmatter}
          location={location}
        >
          {(() => {
            if (PageComponent === Fragment) {
              return <Fragment />
            } else {
              return (
                <PageComponent
                  {...globalStaticData?.props}
                  {...staticProps}
                  frontmatter={frontmatter}
                  location={location}
                />
              )
            }
          })()}
        </RootComponent>
      )
    }
  }

  const assetsTagStr = buildAssetsTagStr({
    pathname: location.pathname,
    assetsTagArray: assetsTagArray,
  })
  const renderdHtml = await renderHtml(<RenderComponent />, assetsTagStr)

  const html = [renderdHtml]

  const stringInitial = getFilePath(
    systemConfig.temp.partialHydration.outDir,
    "string-initial",
    "json"
  )
  if (stringInitial) {
    const targetRelative = path.relative(".", stringInitial)
    const targetJson = JSON.parse(fs.readFileSync(targetRelative, "utf8"))
    const items: { id: string; html: string }[] = targetJson.items

    items.map((item) => {
      const dummy = `<div data-partial-hydration="${item.id}"></div>`
      const reg = new RegExp(`${dummy}`, "g")
      html[0] = html[0].replace(reg, item.html)
      return
    })
  }

  const replacedHtml = html[0].replace(
    /<div class="minista-comment" hidden="">(.+?)<\/div>/g,
    "\n<!-- $1 -->"
  )

  await fs
    .outputFile(routePath, replacedHtml)
    .then(() => {
      showLog &&
        console.log(`${pc.bold(pc.green("BUILD"))} ${pc.bold(routePath)}`)
    })
    .catch((err) => {
      console.error(err)
    })
}

export async function buildTempAssets(
  viteConfig: InlineConfig,
  buildOptions: {
    input: string
    bundleOutName: string
    outDir: string
    assetDir: string
  }
) {
  const customConfig = defineViteConfig({
    build: {
      write: false,
      rollupOptions: {
        input: {
          __minista_bundle_assets: buildOptions.input,
        },
      },
    },
  })
  const mergedConfig = mergeViteConfig(viteConfig, customConfig)

  const result: any = await viteBuild(mergedConfig)
  const items = result.output

  if (Array.isArray(items) && items.length > 0) {
    items.map((item) => {
      if (item.fileName.match(/__minista_bundle_assets\.css/)) {
        const customFileName =
          slashEnd(buildOptions.outDir) + buildOptions.bundleOutName + ".css"
        return item?.source && fs.outputFile(customFileName, item?.source)
      } else if (item.fileName.match(/(__minista_bundle_assets\.js|\.svg$)/)) {
        return
      } else {
        const customFileName =
          buildOptions.outDir + item.fileName.replace(buildOptions.assetDir, "")
        const customCode = item?.source
          ? item?.source
          : item?.code
          ? item?.code
          : ""
        return customCode && fs.outputFile(customFileName, customCode)
      }
    })
  }
}

export function buildAssetsTagArray({
  entryPoints, // (*.css|*.js)
  outBase,
  hrefBase,
  entryPattern = [],
  bundlePattern = [],
  partialPattern = [],
}: {
  entryPoints: string[]
  outBase: string
  hrefBase: string
  entryPattern?: EntryObject[]
  bundlePattern?: EntryObject[]
  partialPattern?: EntryObject[]
}): AssetsTagObject[] {
  const winOutBase = outBase.replaceAll("/", "\\")
  const assets = entryPoints.map((entryPoint) => {
    const assetPath = entryPoint
      .replace(outBase, hrefBase)
      .replace(winOutBase, hrefBase)
      .replaceAll("\\", "/")
    const name = getFilename(assetPath)
    if (assetPath.endsWith(".css")) {
      return {
        name: name,
        assetTag: `<link rel="stylesheet" href="${assetPath}">`,
        assetPath: assetPath,
      }
    } else {
      return {
        name: name,
        assetTag: `<script defer src="${assetPath}"></script>`,
        assetPath: assetPath,
      }
    }
  })
  const patterns = [...entryPattern, ...bundlePattern, ...partialPattern]
  const result = assets.map((asset) => {
    const targetPattern = patterns.find(
      (pattern) => pattern.name === asset.name
    )
    if (targetPattern) {
      return {
        pattern: targetPattern.insertPages,
        assetTag: asset.assetTag,
        assetPath: asset.assetPath,
      }
    } else {
      return {
        pattern: ["**/*"],
        assetTag: asset.assetTag,
        assetPath: asset.assetPath,
      }
    }
  })
  return result
}

export function buildAssetsTagStr({
  pathname,
  assetsTagArray,
}: {
  pathname: string
  assetsTagArray: AssetsTagObject[]
}) {
  if (!assetsTagArray.length) {
    return ""
  }
  const result = assetsTagArray
    .map((item) => {
      const check = picomatch.isMatch(pathname, item.pattern)

      if (!check) {
        return ""
      }
      if (!item.assetPath.startsWith("./")) {
        return item.assetTag
      }

      const slashArray = pathname.match(/\//g)
      const slashCount = slashArray ? slashArray.length : 1

      if (slashCount >= 2) {
        const upStr = [...Array(slashCount - 1)].map(() => "../").join("")
        const relativePath = item.assetPath.replace(/^\.\//, upStr)
        const relativeAssetTag = item.assetTag.replace(
          new RegExp(item.assetPath),
          relativePath
        )
        return relativeAssetTag
      } else {
        return item.assetTag
      }
    })
    .join("")
  return result
}

export async function buildViteImporterRoots(config: MinistaResolveConfig) {
  const outFile = systemConfig.temp.viteImporter.outDir + "/roots.js"
  const rootSrcDir = slashEnd(config.rootSrcDir)
  const rootSrcName = config.root.srcName
  const rootExtStr = config.root.srcExt.join()
  const template = `import { Fragment } from "react"
export const getRoots = () => {
  const ROOTS = import.meta.globEager("/${rootSrcDir}${rootSrcName}.{${rootExtStr}}")
  const roots =
    Object.keys(ROOTS).length === 0
      ? [{ RootComponent: Fragment, getGlobalStaticData: undefined }]
      : Object.keys(ROOTS).map((root) => {
          return {
            RootComponent: ROOTS[root].default ? ROOTS[root].default : Fragment,
            getGlobalStaticData: ROOTS[root].getStaticData
              ? ROOTS[root].getStaticData
              : undefined,
          }
        })
  return roots
}`
  await fs.outputFile(outFile, template).catch((err) => {
    console.error(err)
  })
}

export async function buildViteImporterRoutes(config: MinistaResolveConfig) {
  const outFile = systemConfig.temp.viteImporter.outDir + "/routes.js"
  const pagesDir = slashEnd(config.pagesSrcDir)
  const pagesExtStr = config.pages.srcExt.join()
  const pagesDirRegStr = config.pagesSrcDir.replace(/\//g, "\\/")
  const replacePagesStr = `.replace(/^\\/${pagesDirRegStr}\\//g, "${config.base}")`
  const replaceFileNameArray = config.pages.srcExt.map((ext) => {
    return `.replace(/\\index|\\.${ext}$/g, "")`
  })
  const replaceFileNameArrayStr = replaceFileNameArray.join("\n      ")
  const template = `export const getRoutes = () => {
  const ROUTES = import.meta.globEager("/${pagesDir}**/*.{${pagesExtStr}}")
  const routes = Object.keys(ROUTES).map((route) => {
    const routePath = route
      ${replacePagesStr}
      ${replaceFileNameArrayStr}
      .replace(/\\[\\.{3}.+\\]/, "*")
      .replace(/\\[(.+)\\]/, ":$1")
      .replace(/^.\\//, "/")
    return {
      routePath: routePath,
      PageComponent: ROUTES[route].default,
      getStaticData: ROUTES[route].getStaticData
        ? ROUTES[route].getStaticData
        : undefined,
      frontmatter: ROUTES[route].frontmatter
        ? ROUTES[route].frontmatter
        : undefined,
    }
  })
  return routes
}`
  await fs.outputFile(outFile, template).catch((err) => {
    console.error(err)
  })
}

export async function buildViteImporterAssets(entry: EntryObject[]) {
  const outFile = systemConfig.temp.viteImporter.outDir + "/assets.js"

  const globalEntry = entry.filter(
    (item) => item.insertPages.length === 1 && item.insertPages[0] === "**/*"
  )
  const globalJsEntry = globalEntry.filter((item) =>
    item.input.match(/\.(js|cjs|mjs|jsx|ts|tsx)$/)
  )
  const globalJsImportArray = globalJsEntry.map((item) => {
    return `import("/${item.input}")`
  })
  const globalJsImportStr = globalJsImportArray.join("\n  ")
  const otherEntry = entry.filter(
    (item) => !(item.insertPages.length === 1 && item.insertPages[0] === "**/*")
  )
  const otherImportArray = otherEntry.map((item) => {
    const insertPagesStr = item.insertPages
      .map((pattern) => `"${pattern}"`)
      .join()
    return `  if (picomatch.isMatch(pathname, [${insertPagesStr}])) {
    import("/${item.input}")
  }`
  })
  const otherImportStr = otherImportArray.join("\n  ")
  const template = `import picomatch from "picomatch-browser"
export const getAssets = (pathname) => {
  ${globalJsImportStr}
  ${otherImportStr}
}`
  await fs.outputFile(outFile, template).catch((err) => {
    console.error(err)
  })
}

export async function buildViteImporterBlankAssets() {
  const outFile = systemConfig.temp.viteImporter.outDir + "/assets.js"
  const template = `export const getAssets = () => {
}`
  await fs.outputFile(outFile, template).catch((err) => {
    console.error(err)
  })
}

export async function buildPartialModules(
  moduleFilePaths: string[],
  config: MinistaResolveConfig
): Promise<PartialModules> {
  const moduleData: { id: string; importer: string }[] = []

  await Promise.all(
    moduleFilePaths.map(async (entryPoint) => {
      const entryPointRelative = path.relative(".", entryPoint)
      const underUniqueId = path.parse(entryPoint).name
      const importer = await fs.readFile(entryPointRelative, "utf8")
      moduleData.push({ id: underUniqueId, importer: importer })
      return
    })
  )
  const sortedModuleData = moduleData.sort((a, b) => {
    const nameA = a.importer.toUpperCase()
    const nameB = b.importer.toUpperCase()
    if (nameA < nameB) {
      return -1
    }
    if (nameA > nameB) {
      return 1
    }
    return 0
  })

  const rootStyle = config.assets.partial.rootStyle
  const hasRootStyle = Object.entries(rootStyle).length !== 0
  const partialModules: PartialModules = sortedModuleData.map((item, index) => {
    return {
      id: item.id,
      phId: `PH_${index + 1}`,
      phDomId: `${config.assets.partial.rootValuePrefix}-${index + 1}`,
      htmlId: `html_${index + 1}`,
      targetsId: `targets_${index + 1}`,
      importer: item.importer,
      rootAttr: `data-${config.assets.partial.rootAttrSuffix}`,
      rootDOMElement: config.assets.partial.rootDOMElement,
      rootStyleStr: hasRootStyle ? reactStylesToString(rootStyle) : "",
    }
  })
  return partialModules
}

export async function buildPartialStringIndex(
  partialModules: PartialModules,
  buildOptions: { outFile: string }
) {
  const tmpImporters: string[] = partialModules.map((module) => {
    return `import ${module.phId} from "${module.importer}"`
  })
  const tmpRenders: string[] = partialModules.map((module) => {
    return `// ${module.phId}
const ${module.htmlId} = renderToString(React.createElement(${module.phId}))`
  })
  const tmpExports: string[] = partialModules.map((module) => module.htmlId)

  const tmpImporterStr = tmpImporters.join("\n")
  const tmpRendersStr = tmpRenders.join("\n")
  const tmpExportsStr = tmpExports.join(", ")

  const outFile = buildOptions.outFile
  const template = `import { renderToString } from "react-dom/server.js"
${tmpImporterStr}

${tmpRendersStr}

export { ${tmpExportsStr} }`

  await fs.outputFile(outFile, template).catch((err) => {
    console.error(err)
  })
}

export async function buildPartialStringBundle(
  entryPoint: string,
  buildOptions: {
    outFile: string
    alias: AliasArray
    mdxConfig: MdxOptions
    svgrOptions: SvgrOptions
    cssOptions: CssOptions
  }
) {
  await esBuild({
    entryPoints: [entryPoint],
    outfile: buildOptions.outFile,
    bundle: true,
    format: "esm",
    platform: "node",
    inject: [
      path.resolve(__dirname + "/../lib/shim-react.js"),
      //path.resolve(__dirname + "/../lib/shim-fetch.js"),
    ],
    external: esbuildExternals,
    loader: esbuildLoaders,
    plugins: [
      resolvePlugin({ "react/jsx-runtime": "react/jsx-runtime.js" }),
      cssModulePlugin(buildOptions.cssOptions, buildOptions.alias),
      mdx(buildOptions.mdxConfig),
      svgrPlugin(buildOptions.svgrOptions),
      rawPlugin(buildOptions.alias),
    ],
  }).catch(() => process.exit(1))
}

export async function buildPartialStringInitial(
  entryPoint: string,
  partialModules: PartialModules,
  buildOptions: {
    outFile: string
  }
) {
  const outFile = buildOptions.outFile
  const targetFilePath = url.pathToFileURL(entryPoint).href
  const partialString: PartialString = await import(targetFilePath)

  const items = partialModules.map((module) => {
    const html = partialString[module.htmlId]
    const dom = module.rootDOMElement
    const dataId = `${module.rootAttr}="${module.phDomId}"`
    const style = module.rootStyleStr ? ` style="${module.rootStyleStr}"` : ""
    const replacedHtml = `<${dom} ${dataId}${style}>${html}</${dom}>`
    return {
      id: module.id,
      html: replacedHtml,
    }
  })
  const template = { items: items }

  await fs.outputJson(outFile, template, { spaces: 2 }).catch((err) => {
    console.error(err)
  })
}

export async function buildPartialHydratePages(
  partialModules: PartialModules,
  config: MinistaResolveConfig,
  buildOptions: {
    roots: string[]
    pages: string[]
    outBase: string
    outFile: string
  }
) {
  async function searchHasPhIds(targetPath: string, phIds: string[]) {
    const targetPathRelative = path.relative(".", targetPath)
    const code = await fs.readFile(targetPathRelative, "utf8")
    const codeWithPhIds = phIds.filter((phId) => code.includes(phId))
    return { path: targetPath, hasPhIds: codeWithPhIds }
  }

  const phIds = partialModules.map((item) => item.id)

  const roots: { path: string; hasPhIds: string[] }[] = []
  const pages: { path: string; hasPhIds: string[] }[] = []

  await Promise.all(
    buildOptions.roots.map(async (item) => {
      const root = await searchHasPhIds(item, phIds)
      return roots.push(root)
    })
  )
  await Promise.all(
    buildOptions.pages.map(async (item) => {
      const page = await searchHasPhIds(item, phIds)
      return pages.push(page)
    })
  )

  const rootHasPhIds = roots.length > 0 ? roots[0].hasPhIds : ""
  const pagesWithRoot = pages.map((item) => ({
    path: item.path,
    hasPhIds: [...new Set([...item.hasPhIds, ...rootHasPhIds])].sort(),
    groupId: [...new Set([...item.hasPhIds, ...rootHasPhIds])].sort().join("-"),
  }))

  const groupIds = [
    ...new Set(
      pagesWithRoot.map((item) => item.groupId).filter((item) => item)
    ),
  ].sort()
  const groups = groupIds.map((item) => ({
    groupId: item,
    pages: pagesWithRoot.filter((childItem) => childItem.groupId === item),
  }))

  const hydratePages = groups.map((item, index) => {
    const name = `${config.assets.partial.outName}-${index + 1}`
    const winOutBase = buildOptions.outBase.replaceAll("/", "\\")
    const reg1 = new RegExp(`^${buildOptions.outBase}|index.mjs`, "g")
    const reg2 = new RegExp(`.mjs`, "g")
    const insertPages = item.pages.map((childItem) =>
      childItem.path
        .replace(reg1, "")
        .replace(reg2, "")
        .replace(winOutBase, "")
        .replaceAll("\\", "/")
    )
    const reg = new RegExp(`(${item.pages[0].hasPhIds.join("|")})`, "g")
    const hasPartialModules = partialModules.filter((item) =>
      item.id.match(reg)
    )
    return {
      name: name,
      insertPages: insertPages,
      hasPartialModules: hasPartialModules,
    }
  })
  const template = hydratePages

  //console.log("buildOptions.roots", buildOptions.roots)
  //console.log("buildOptions.pages", buildOptions.pages)
  //console.log("roots", roots)
  //console.log("pages", pages)
  //console.log("pagesWithRoot", pagesWithRoot)
  //console.log("groupIds", groupIds)
  //console.log("groups", groups)
  //console.log("hydratePages", hydratePages)

  await fs
    .outputJson(buildOptions.outFile, template, { spaces: 2 })
    .catch((err) => {
      console.error(err)
    })
  return hydratePages
}

export async function buildPartialHydrateIndex(
  partialModules: PartialModules,
  config: MinistaResolveConfig,
  buildOptions: { outFile: string }
) {
  const tmpImporters: string[] = partialModules.map((module) => {
    return `import ${module.phId} from "${module.importer}"`
  })
  const tempFunctionIntersectionObserver = `const options = {
      root: ${config.assets.partial.intersectionObserverOptions.root},
      rootMargin: "${config.assets.partial.intersectionObserverOptions.rootMargin}",
      thresholds: ${config.assets.partial.intersectionObserverOptions.thresholds},
    }
    const observer = new IntersectionObserver(hydrate, options)
    observer.observe(target)

    function hydrate() {
      ReactDOM.hydrate(App, target)
      observer.unobserve(target)
    }`
  const tempFunctionImmediateExecution = `ReactDOM.hydrate(App, target)`
  const tempFunction = config.assets.partial.useIntersectionObserver
    ? tempFunctionIntersectionObserver
    : tempFunctionImmediateExecution
  const tmpRenders: string[] = partialModules.map((module) => {
    return `
// ${module.phId}
const ${module.targetsId} = document.querySelectorAll('[${module.rootAttr}="${module.phDomId}"]')
if (${module.targetsId}) {
  ${module.targetsId}.forEach(target => {
    const App = React.createElement(${module.phId})
    ${tempFunction}
  })
}`
  })

  const tmpImporterStr = tmpImporters.join("\n")
  const tmpRendersStr = tmpRenders.join("\n")

  const outFile = buildOptions.outFile
  const template = `import React from "react"
import ReactDOM from "react-dom"
${tmpImporterStr}
${tmpRendersStr}`

  await fs.outputFile(outFile, template).catch((err) => {
    console.error(err)
  })
}

export async function buildPartialHydrateAsset(
  viteConfig: InlineConfig,
  config: MinistaResolveConfig,
  buildOptions: {
    input: string
    bundleOutName: string
    outDir: string
    assetDir: string
    usePreact: boolean
  }
) {
  const activePreact = buildOptions.usePreact && userPkgHasPreact
  const resolveAliasPreact = [
    {
      find: "react",
      replacement: "preact/compat",
    },
    {
      find: "react-dom",
      replacement: "preact/compat",
    },
  ]
  const customConfig = defineViteConfig({
    base: viteConfig.base,
    build: {
      write: false,
      assetsInlineLimit: 0,
      minify: viteConfig.build?.minify,
      rollupOptions: {
        input: {
          __minista_bundle_assets: buildOptions.input,
        },
        output: {
          manualChunks: undefined,
          assetFileNames: (chunkInfo) =>
            resolveaAssetFileName(chunkInfo, config),
        },
      },
    },
    esbuild: viteConfig.esbuild,
    plugins: viteConfig.plugins,
    resolve: {
      alias: activePreact ? resolveAliasPreact : [],
    },
    logLevel: "error",
    css: config.css,
  })

  const mergedConfig = mergeViteConfig({}, customConfig)

  if (config.alias.length > 0) {
    await Promise.all(
      config.alias.map(async (item) => {
        return mergedConfig.resolve.alias.push(item)
      })
    )
  }

  const result: any = await viteBuild(mergedConfig)
  const items = result.output

  if (Array.isArray(items) && items.length > 0) {
    items.map((item) => {
      if (item.fileName.match(/(\.css|\.svg)$/)) {
        return
      } else if (item.fileName.match(/(\.js)$/)) {
        const customFileName =
          slashEnd(buildOptions.outDir) + buildOptions.bundleOutName + ".js"
        return item?.code && fs.outputFile(customFileName, item?.code)
      } else {
        const customFileName =
          buildOptions.outDir + item.fileName.replace(buildOptions.assetDir, "")
        const customCode = item?.source
          ? item?.source
          : item?.code
          ? item?.code
          : ""
        return customCode && fs.outputFile(customFileName, customCode)
      }
    })
  }
}

export async function buildSearchJson({
  config,
  useCacheExists,
  entryPoints,
  entryBase,
  outFile,
  showLog,
}: {
  config: MinistaResolveConfig
  useCacheExists: boolean
  entryPoints: string[]
  entryBase: string
  outFile: string
  showLog: boolean
}) {
  if (useCacheExists) {
    return
  }

  const { trimTitle, targetSelector, hit } = config.search

  const tempWords: string[] = []
  const tempPages: {
    path: string
    toc: [number, string][]
    title: string[]
    content: string[]
  }[] = []

  await Promise.all(
    entryPoints.map(async (filePath: string) => {
      const html = await fs.readFile(filePath, { encoding: "utf-8" })
      const parsedHtml = parse(html, {
        blockTextElements: { script: false, style: false, pre: false },
      })

      const regTrimPath = new RegExp(`^${entryBase}|index|.html`, "g")
      const path = filePath.replace(regTrimPath, "")

      const regTrimTitle = new RegExp(trimTitle)
      const pTitle = parsedHtml.querySelector("title") as NhpHTML
      const title = pTitle ? pTitle.rawText.replace(regTrimTitle, "") : ""
      const titleArray = mojigiri(title)

      const targetContent = parsedHtml.querySelector(targetSelector)

      if (!targetContent) {
        tempWords.push(title)
        tempPages.push({
          path: path,
          toc: [],
          title: titleArray,
          content: [],
        })
        return
      }

      const contents: { type: string; value: string[] }[] = []

      async function getContent(element: any) {
        if (element.id) {
          contents.push({ type: "id", value: [element.id] })
        }
        if (element._rawText) {
          const text = element._rawText
            .replace(/\n/g, "")
            .replace(/\s{2,}/g, " ")
            .trim()
          const words = mojigiri(text)

          if (words.length > 0) {
            contents.push({ type: "words", value: words })
          }
        }
        if (element.childNodes) {
          await Promise.all(
            element.childNodes.map(async (childNode: any) => {
              return await getContent(childNode)
              //console.log("childNode", childNode)
            })
          )
        }
        return
      }

      await getContent(targetContent)
      //console.log("contents", contents)

      const toc: [number, string][] = []
      const contentArray: string[][] = []

      let contentCount = 0

      contents.forEach((content) => {
        if (content.type === "id") {
          toc.push([contentCount, content.value[0]])
          return
        } else if (content.type === "words") {
          contentArray.push(content.value)
          contentCount = contentCount + content.value.length
          return
        }
      })

      const body = targetContent.rawText
        .replace(/\n/g, "")
        .replace(/\s{2,}/g, " ")
        .trim()

      tempWords.push(title)
      tempWords.push(body)
      tempPages.push({
        path: path,
        toc: toc,
        title: titleArray,
        content: contentArray.flat(),
      })

      //console.log("querySelector", parsedHtml.querySelector(targetSelector))
      //console.log("content", content)
    })
  )

  const words = mojigiri(tempWords.join(" "))
  const sortedWords = [...new Set(words)].sort()

  const regHitsArray = [
    hit.number && "[0-9]",
    hit.english && "[a-zA-Z]",
    hit.hiragana && "[ぁ-ん]",
    hit.katakana && "[ァ-ヴ]",
    hit.kanji &&
      "[\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u3005\u3007\u3021-\u3029\u3038-\u303B\u3400-\u4DB5\u4E00-\u9FC3\uF900-\uFA2D\uFA30-\uFA6A\uFA70-\uFAD9]",
  ].filter((reg) => reg)
  const regHits = new RegExp(`(${regHitsArray.join("|")})`)
  //console.log("regHitsArray", regHitsArray)
  //console.log("regHits", regHits)

  const tempHits = sortedWords.filter(
    (word) =>
      word.length >= hit.minLength && regHits.test(word) && word !== "..."
  )
  const hits = tempHits.map((word) => {
    return sortedWords.indexOf(word)
  })
  //console.log("tempHits", JSON.stringify(tempHits, null, 1))
  //console.log("hits", hits)

  const pages: {
    path: string
    title: number[]
    toc: [number, string][]
    content: number[]
  }[] = []

  await Promise.all(
    tempPages.map(async (page) => {
      const path = page.path
      const toc = page.toc
      const title = page.title.map((word) => {
        return sortedWords.indexOf(word)
      })
      const content = page.content.map((word) => {
        return sortedWords.indexOf(word)
      })

      pages.push({ path: path, title: title, toc: toc, content: content })
    })
  )

  const sortedPages = pages.sort((a, b) => {
    const pathA = a.path.toUpperCase()
    const pathB = b.path.toUpperCase()
    if (pathA < pathB) {
      return -1
    }
    if (pathA > pathB) {
      return 1
    }
    return 0
  })

  const template = {
    words: sortedWords,
    hits: hits,
    pages: sortedPages,
  }

  await fs
    .outputJson(outFile, template)
    .then(() => {
      showLog &&
        console.log(`${pc.bold(pc.green("BUILD"))} ${pc.bold(outFile)}`)
    })
    .catch((err) => {
      console.error(err)
    })
  return
}

export async function buildCopyDir(
  targetDir: string,
  outDir: string,
  log?: "public" | "assets"
) {
  const checkTargetDir = await fs.pathExists(targetDir)
  if (checkTargetDir) {
    return await fs
      .copy(targetDir, outDir)
      .then(() => {
        if (log === "public") {
          console.log(
            `${pc.bold(pc.green("BUILD"))} ${pc.bold(
              targetDir + "/**/* -> " + outDir
            )}`
          )
        }
        if (log === "assets") {
          console.log(`${pc.bold(pc.green("BUILD"))} ${pc.bold(outDir)}`)
        }
      })
      .catch((err) => {
        console.error(err)
      })
  } else {
    return
  }
}
