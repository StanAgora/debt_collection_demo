// Read-only service check; does not create any calls.
const { EslClient } = require('../lib/esl');
const client = new EslClient({ host: process.env.FREESWITCH_HOST || '127.0.0.1', port: Number(process.env.FREESWITCH_ESL_PORT || 8021), password: process.env.FREESWITCH_ESL_PASSWORD });
(async () => {
  try {
    await client.connect();
    const status = await client.api('sofia status');
    if (!/internal[^\n]*RUNNING/.test(status) || !/external[^\n]*RUNNING/.test(status)) throw new Error('SIP profile 未全部启动');
    console.log('ESL authentication and both SIP profiles: OK');
    console.log(await client.api('version'));
    console.log(await client.api('sofia status profile internal reg'));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { client.close(); }
})();
