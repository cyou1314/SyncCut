import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(value,'utf8').digest('hex');
export function createOAuthStateStore({db,cipher}) {
  return {
    async create({hash,sessionId,verifier,expiresAt}) {
      if (!/^[0-9a-f]{64}$/.test(hash) || !sessionId || !verifier || !Number.isFinite(expiresAt)) throw new Error('Invalid OAuth state');
      const value=cipher.encrypt(verifier);
      await db.query('insert into feishu_oauth_states (state_hash,session_hash,verifier_ciphertext,verifier_nonce,verifier_tag,expires_at) values ($1,$2,$3,$4,$5,$6)',[hash,digest(sessionId),value.ciphertext,value.nonce,value.tag,new Date(expiresAt)]);
    },
    async consume({hash,sessionId,now}) {
      if (!sessionId) return null;
      const result=await db.query('delete from feishu_oauth_states where state_hash=$1 and session_hash=$2 and expires_at > $3 returning verifier_ciphertext,verifier_nonce,verifier_tag',[hash,digest(sessionId),new Date(now)]);
      if (!result.rowCount) return null;
      const row=result.rows[0];
      return {verifier:cipher.decrypt({ciphertext:row.verifier_ciphertext,nonce:row.verifier_nonce,tag:row.verifier_tag})};
    },
  };
}
