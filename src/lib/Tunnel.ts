import axios, { AxiosRequestConfig } from 'axios';
import { EventEmitter } from 'events';

import TunnelCluster from './TunnelCluster.js';
import { newLogger } from './logger.js';

export const sleep = (ts: number) => new Promise<void>((resolve) => setTimeout(() => resolve(), ts))

export type TunnelOptions = {
  
  host?: string
  port?: number

  subdomain?: string

  local_host?: string
  local_hostname?: string

  local_https?: string, 
  local_cert?: string, 
  local_key?: string, 
  local_ca?: string, 
  allow_invalid_cert?: boolean

}

export default class Tunnel extends EventEmitter {

  private readonly logger = newLogger(Tunnel.name)

  private closed: boolean
  private tunnelCluster: TunnelCluster
  
  private clientId: string
  private url: string
  private cachedUrl: string

  constructor(private readonly opts: TunnelOptions = {}) {
    super();
    this.closed = false;
    if (!this.opts.host) {
      this.opts.host = 'https://localtunnel.me';
    }
  }

  getURL() {
    return this.url
  }

  getCachedURL() {
    return this.cachedUrl
  }

  getClientId() {
    return this.clientId
  }

  private getInfo(body) {
     
    const { id, ip, port, url, cached_url, max_conn_count } = body;
    const { host, port: local_port, local_host } = this.opts;
    const { local_https, local_cert, local_key, local_ca, allow_invalid_cert } = this.opts;
    return {
      name: id,
      url,
      cached_url,
      max_conn: max_conn_count || 1,
      remote_host: new URL(host).hostname,
      remote_ip: ip,
      remote_port: port,
      local_port,
      local_host,
      local_https,
      local_cert,
      local_key,
      local_ca,
      allow_invalid_cert,
    };
     
  }

  // initialize connection
  // callback with connection info
  private async init() {

    const opt = this.opts;

    const params: AxiosRequestConfig = {
      responseType: 'json',
    };

    const baseUri = `${opt.host}/`;
    // no subdomain at first, maybe use requested domain
    const assignedDomain = opt.subdomain;
    // where to quest
    const uri = baseUri + (assignedDomain || '?new');

    const retry = true
    while(retry) {
      try {
        const res = await axios.get(uri, params)

        const body = res.data;

        this.logger.debug(`got tunnel information ${JSON.stringify(res.data)}`);

        if (res.status !== 200) {
          const err = new Error(
            (body && body.message) || 'localtunnel server returned an error, please try again'
          );
          throw err
        }

        return this.getInfo(body)
      }  catch (err) {
        this.logger.debug(`tunnel server ${uri} offline: ${err.message}, retry 1s`);
        await sleep(1000)
      }
    }

    throw new Error("Failed to start tunnel")
  }

  private establish(info) {
    // increase max event listeners so that localtunnel consumers don't get
    // warning messages as soon as they setup even one listener. See #71
    this.setMaxListeners(info.max_conn + (EventEmitter.defaultMaxListeners || 10));

    this.tunnelCluster = new TunnelCluster(info);

    // only emit the url the first time
    this.tunnelCluster.once('open', () => {
      this.emit('url', info.url);
    });

    // re-emit socket error
    this.tunnelCluster.on('error', err => {
      this.logger.debug(`got socket error ${err.message}`);
      this.emit('error', err);
    });

    let tunnelCount = 0;

    // track open count
    this.tunnelCluster.on('open', tunnel => {
      tunnelCount++;
      this.logger.debug(`tunnel open [total: ${tunnelCount}]`);

      const closeHandler = () => {
        tunnel.destroy();
      };

      if (this.closed) {
        return closeHandler();
      }

      this.once('close', closeHandler);
      tunnel.once('close', () => {
        this.removeListener('close', closeHandler);
      });
    });

    // when a tunnel dies, open a new one
    this.tunnelCluster.on('dead', () => {
      tunnelCount--;
      this.logger.debug(`tunnel dead [total: ${tunnelCount}]`);
      if (this.closed) {
        return;
      }
      this.tunnelCluster.open();
    });

    this.tunnelCluster.on('request', req => {
      this.emit('request', req);
    });

    // establish as many tunnels as allowed
    for (let count = 0; count < info.max_conn; ++count) {
      this.tunnelCluster.open();
    }
  }

  async open() {
    const info = await this.init()

    this.clientId = info.name;
    this.url = info.url;

    // `cached_url` is only returned by proxy servers that support resource caching.
    if (info.cached_url) {
      this.cachedUrl = info.cached_url;
    }

    this.establish(info);
  }

  close() {
    this.closed = true;
    this.emit('close');
  }
};
