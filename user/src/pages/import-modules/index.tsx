import { Head } from "minista"
import pkg from "../../../node_modules/minista/package.json"

const PageImportModules = () => {
  return (
    <>
      <Head>
        <title>import Modules</title>
      </Head>
      <h1>import Modules</h1>
      <h2>test node_module json</h2>
      <p>minista v{pkg.version}</p>
    </>
  )
}

export default PageImportModules
