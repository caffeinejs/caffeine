import { Router } from '@caffeinejs/http'

import { DevToolsAPI } from '../api.js'
import { kConfig } from '../app.config.js'
import { JSONView, KeyValue } from '../shared/components/index.js'
import { page } from '../shared/layout/index.js'

/** The application and the process it runs in. */
export const infoRouter = new Router('/info')
  .inject({ api: DevToolsAPI, config: kConfig })
  .get('/', async (_ctx, { api, config }) => {
    const info = await api.info()

    return page(api, config, {
      title: 'Info',
      active: '/info',
      body: (
        <>
          <h2>Application</h2>
          <KeyValue
            rows={[
              ['name', info.application.name],
              ['profiles', info.application.profiles],
            ]}
          />
          <h2>Runtime</h2>
          <KeyValue rows={Object.entries(info.runtime)} />
          <h2>What the features run</h2>
          {info.application.contrib.length === 0 ? (
            <p class="muted">No feature reported anything.</p>
          ) : (
            <JSONView value={info.application.contrib} />
          )}
        </>
      ),
    })
  })
