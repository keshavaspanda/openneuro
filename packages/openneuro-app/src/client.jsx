/**
 * Browser client entrypoint - see server.tsx for SSR entrypoint
 */
import "./scripts/utils/global-polyfill"
import "./scripts/apm.js"
import { ApolloProvider, InMemoryCache } from "@apollo/client"
import { createClient } from "@openneuro/client"
import React from "react"
import ReactDOM from "react-dom"
import { BrowserRouter, Route, Routes } from "react-router-dom"
import App from "./scripts/app"
import Index from "./scripts/index"
import { version } from "./lerna.json"
import { config } from "./scripts/config"
import * as gtag from "./scripts/utils/gtag"
import { relayStylePagination } from "@apollo/client/utilities"
import "@openneuro/components/page/page.scss"

gtag.initialize(config.analytics.trackingIds)

ReactDOM.render(
  <App>
    <ApolloProvider
      client={createClient(`${config.url}/crn/graphql`, {
        clientVersion: version,
        cache: new InMemoryCache({
          typePolicies: {
            Query: {
              fields: {
                advancedSearch: relayStylePagination(),
              },
            },
          },
        }),
      })}
    >
      <BrowserRouter>
        <Routes>
          <Route path="*" element={<Index />} />
        </Routes>
      </BrowserRouter>
    </ApolloProvider>
  </App>,
  document.getElementById("main"),
)
