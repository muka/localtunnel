import Tunnel, { TunnelOptions } from './lib/Tunnel.js';


const localtunnel = async (options: TunnelOptions) => {
  const client = new Tunnel(options);
  await client.open()
  return client
};


export default localtunnel