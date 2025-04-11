import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import tls from 'tls';

import HeaderHostTransformer from './HeaderHostTransformer.js';
import { newLogger } from './logger.js';
import Stream from 'stream';

type SocketError = Error & { code: string }

type TunnelClusterOptions = {
  
  remote_host?: string
  remote_ip?: string
  remote_port?: number
  
  local_host?: string
  local_port?: number
  local_https?: string

  allow_invalid_cert?: boolean
  local_cert?: string
  local_key?: string
  local_ca?: string
}

// manages groups of tunnels
export default class TunnelCluster extends EventEmitter {

  private readonly logger = newLogger(TunnelCluster.name)

  constructor(private readonly opts: TunnelClusterOptions = {}) {
    super();
  }

  open() {
    const opt = this.opts;

    // Prefer IP if returned by the server
    const remoteHostOrIp = opt.remote_ip || opt.remote_host;
    const remotePort = opt.remote_port;
    const localHost = opt.local_host || 'localhost';
    const localPort = opt.local_port;
    const localProtocol = opt.local_https ? 'https' : 'http';
    const allowInvalidCert = opt.allow_invalid_cert;

    this.logger.debug(
      `establishing tunnel ${localProtocol}://${localHost}:${localPort} <> ${remoteHostOrIp}:${remotePort}`
    );

    // connection to localtunnel server
    const remote = net.connect(+remotePort, remoteHostOrIp, () => {});

    remote.setKeepAlive(true);

    remote.on('error', (err: SocketError) => {
      this.logger.debug(`got remote connection error ${err.message}`);

      // emit connection refused errors immediately, because they
      // indicate that the tunnel can't be established.
      if (err.code === 'ECONNREFUSED') {
        this.emit(
          'error',
          new Error(
            `connection refused: ${remoteHostOrIp}:${remotePort} (check your firewall settings)`
          )
        );
      }

      remote.end();
    });

    const connLocal = () => {
      if (remote.destroyed) {
        this.logger.debug('remote destroyed');
        this.emit('dead');
        return;
      }

      this.logger.debug(`connecting locally to ${localProtocol}://${localHost}:${localPort}`);
      remote.pause();

      if (allowInvalidCert) {
        this.logger.debug('allowing invalid certificates');
      }

      const getLocalCertOpts = () =>
        allowInvalidCert
          ? { rejectUnauthorized: false }
          : {
            cert: fs.readFileSync(opt.local_cert),
            key: fs.readFileSync(opt.local_key),
            ca: opt.local_ca ? [fs.readFileSync(opt.local_ca)] : undefined,
          };

      // connection to local http server
      const local = opt.local_https
        ? tls.connect({ host: localHost, port: localPort, ...getLocalCertOpts() })
        : net.connect({ host: localHost, port: localPort });

      const remoteClose = () => {
        this.logger.debug('remote close');
        this.emit('dead');
        local.end();
      };

      remote.once('close', remoteClose);

      // TODO some languages have single threaded servers which makes opening up
      // multiple local connections impossible. We need a smarter way to scale
      // and adjust for such instances to avoid beating on the door of the server
      local.once('error', (err: SocketError) => {
        this.logger.debug(`local error ${err.message}`);
        local.end();

        remote.removeListener('close', remoteClose);

        if (err.code !== 'ECONNREFUSED'
            && err.code !== 'ECONNRESET') {
          remote.end();
          return 
        }

        // retrying connection to local server
        setTimeout(connLocal, 1000);
      });

      local.once('connect', () => {
        this.logger.debug('connected locally');
        remote.resume();

        let stream: Stream = remote;

        // if user requested specific local host
        // then we use host header transform to replace the host header
        if (opt.local_host) {
          this.logger.debug(`transform Host header to ${opt.local_host}`);
          stream = remote.pipe(new HeaderHostTransformer({ host: opt.local_host }));
        }

        stream.pipe(local).pipe(remote);

        // when local closes, also get a new remote
        local.once('close', hadError => {
          this.logger.debug(`local connection closed [${hadError}]`);
        });
      });
    };

    remote.on('data', data => {
      const match = data.toString().match(/^(\w+) (\S+)/);
      if (match) {
        this.emit('request', {
          method: match[1],
          path: match[2],
        });
      }
    });

    // tunnel is considered open when remote connects
    remote.once('connect', () => {
      this.emit('open', remote);
      connLocal();
    });
  }
};
