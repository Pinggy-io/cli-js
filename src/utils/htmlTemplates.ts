import { FileServerError } from "./FileServer.js"

export function directoryListingHtml(relativePath: string, list: string): string {
  return (

    `
<html>
    <head>
      <meta charset="utf-8" />
      <title>Index of ${relativePath}</title>
      <style>
        body {
          font-family: sans-serif;
          margin: 0;
          padding: 0;
          height: 100vh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        header {
          padding: 20px;
          background: #f9f9f9;
          border-bottom: 1px solid #eee;
        }
        main {
          flex: 1;
          overflow-y: auto;
          padding: 20px;
        }
        ul {
          list-style-type: none;
          padding-left: 0;
          margin: 0;
        }
        li {
          margin: 4px 0;
        }
        a {
          text-decoration: none;
          color: #0366d6;
        }
        a:hover {
          text-decoration: underline;
        }
        footer {
          position: fixed;
          bottom: 0;
          left: 0;
          width: 100%;
          background: #f9f9f9;
          border-top: 1px solid #eee;
          text-align: center;
          padding: 10px 0;
          font-size: 0.9em;
          color: #777;
        }
      </style>
    </head>
    <body>
      <header><h1>Index of ${relativePath}</h1></header>
      <main>
        <ul>${list}</ul>
      </main>
      <footer>
        Powered by <a href="https://pinggy.io" target="_blank">Pinggy</a>
      </footer>
    </body>
  </html>
  `
  )
}

export function invalidPathErrorHtml(invalidPathError: FileServerError): string {

  return (
    `
       <html>
    <head>
      <meta charset="utf-8" />
      <title>File server error</title>
      <style>
        body {
          font-family: sans-serif;
          margin: 0;
          padding: 0;
          height: 100vh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        header {
          padding: 15px;
          background: #f9f9f9;
          border-bottom: 1px solid #eee;
        }
        main {
          flex: 1;
          overflow-y: auto;
          padding: 20px;
        }
        ul {
          list-style-type: none;
          padding-left: 0;
          margin: 0;
        }
        li {
          margin: 4px 0;
        }
        a {
          text-decoration: none;
          color: #0366d6;
        }
        a:hover {
          text-decoration: underline;
        }
        footer {
          position: fixed;
          bottom: 0;
          left: 0;
          width: 100%;
          background: #f9f9f9;
          border-top: 1px solid #eee;
          text-align: center;
          padding: 10px 0;
          font-size: 0.9em;
          color: #777;
        }
      </style>
    </head>
    <body>
      <header><h1>⚠️ File Server Error</h1></header>
      <main>
              <p>${invalidPathError.message}</p>
              <p>Error Code: <code>${invalidPathError.code}</code></p>
      </main>
      <footer>
        Powered by <a href="https://pinggy.io" target="_blank">Pinggy</a>
      </footer>
    </body>
  </html>
          `
  )

}

