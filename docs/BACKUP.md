# Backups e restauração do MongoDB (Fase 2.1)

## Contratos operacionais (RPO/RTO medidos, não estimados)

| Métrica | Valor | Como foi medido |
|---|---|---|
| RPO (perda aceitável) | **24h** | cadência do agendador: 1 backup/dia (configurável com `--rpo-hours`) |
| RTO (restauração) | **1s em banco de autenticação pequeno** | `scripts/test-backup.sh` cronometra de `restore.sh` até o login voltar 200 |
| Retenção | **7 diários + 4 semanas** (≈ 35 dias) | `--retain-daily`/`--retain-weekly`, poda após cada backup e via `--prune-only` |

O RTO de 1s é para a base deste serviço (uma coleção `users`). Ele **cresce
com o tamanho dos dados**; a fórmula de referência para o operador é
_bytes_decifrados / vazão_ + _start do Mongo_. O número importante é o contrato:
**o restore é exercitado de ponta a ponta antes de precisar dele.**

## O que o backup é (e não é)

- É um **dump lógico** (`mongodump --archive`) do Mongo inteiro, **cifrado com
  gpg AES-256 simétrico** durante a geração — o texto claro nunca toca o disco
  do host: `docker exec <mongo> mongodump --archive --gzip` é entregue por
  pipe direto ao `gpg`, e o que sobra é só `sha-data-<data>.archive.gpg`.
- **Não é snapshot**: consistência por coleção, não um ponto no tempo do disco.
  Para uma base de autenticação pequena é o contrato da Fase 2.1.
- **A chave é o arquivo de passphrase** (fora do repositório, `chmod 600`):
  quem tem o `.archive.gpg` + passphrase tem o banco; quem não tem o arquivo
  não tem nada. `restore.sh` não aceita passphrase em linha de comando
  (nada em `ps` do host).

### Decisões: por que gpg e por que `--archive`

O roadmap citava "age/gpg simétrico" e "tar". O projeto segue com **gpg** e
**archive único**:

- age não existe na base do host nem nas imagens já usadas; baixar binário
  novo só para o backup é dependência que o runbook não deve criar. gpg está
  presente e é a mesma classe (AES-256 simétrica).
- `--archive` é um fluxo único: atômico por construção. `mongodump --dir` + tar
  adiciona um segundo ponto de falha (tar completo depois de dump parcial),
  e o `mongorestore --dryRun` rejeita archive truncado/corrompido na hora.

## Criar backup

```sh
scripts/backup.sh --project micrologin \
  --backups-dir ./backups \
  --passphrase-file /caminho/seguro/passphrase \
  --retain-daily 7 --retain-weekly 4
```

O container do Mongo é resolvido por label de projeto, nunca por nome:
`--project micrologin` acha `micrologin-mongodb-1`, `--project X` acha o do
seu stack. Cada backup passa por **verificação automática** antes de ser
aceito: decifra → `gzip -t` → `mongorestore --dryRun` **contra o próprio
servidor**, sem escrever nada. Se qualquer etapa falhar, o arquivo é apagado
e o script sai com código 1.

No sucesso grava `backups/last-backup.json` (manifest com timestamp,
sha256 do arquivo cifrado e `rpo_h`) e emite um evento estruturado:

```json
{"event":"backup_ok","project":"micrologin","file":"sha-data-....archive.gpg","bytes":"1481","sha256":"...","rpo_h":24}
```

## Agendamento e alerta

O cron deve reagir ao exit code e ao último evento do script:

```cron
17 02 * * * /opt/auth/scripts/backup.sh --passphrase-file /opt/backup.pass >> /var/log/backup.log 2>&1
```

`--check` é o gancho de alerta: sai 0 se o `last-backup.json` existe e tem no
máximo `--rpo-hours` (default 24) de idade, e **sai 1** (emitindo
`{"event":"backup_stale",...}`) se o backup falhou, ficou velho ou nunca
existiu. Um monitor externo (Zabbix/Healthchecks/Prometheus via exporter)
reage ao exit code e à linha estruturada no stderr:

```sh
scripts/backup.sh --check --backups-dir ./backups   # roda a cada 30 min
```

## Restauração pontual (só com o dump cifrado, sem acesso ao servidor)

O operador que vai restaurar precisa de **duas coisas**: o arquivo
`.archive.gpg` e a passphrase. Nenhum shell no host, nenhuma credencial de
servidor — só `docker exec` no (resolvido por label como no backup).

```sh
scripts/restore.sh ./backups/sha-data-20260930T120000Z.archive.gpg \
  --passphrase-file /caminho/seguro/passphrase --yes
```

Ordem de segurança do `restore.sh`:

1. decifra e valida (gzip íntegro);
2. `mongorestore --dryRun` contra o Mongo **sem escrever nada** — archive
   corrompido não encosta nos dados atuais;
3. restaura com `--drop` (substitui as coleções atuais).

`--dry-run` para só validar; `latest` para restaurar o backup mais novo de
`--backups-dir`.

> **Aviso sobre o `--drop`**: o dump é do Mongo inteiro, então a restauração
> também substitui `admin.system.users` (usuários do banco, inclusive o root)
> pela versão do backup. Depois de restaurar, as credenciais de app/root devem
> corresponder ao dump ou serem rotacionadas (`scripts/rotate-dependency-secrets.sh`).

## Limite documentado: restore em volume vazio do zero

O drill e o `restore.sh` restauram **em um Mongo já autenticado em pé** (dropar
o banco de dados, restaurar). Restaurar em um volume **virgem** (Mongo sem
nenhum usuário) não é coberto aqui: sem credencial não há como o `mongorestore`
conectar. Para DR do zero, o procedimento é subir o stack normal
(`docker compose up -d`), que recria os usuários via `10-app-user.sh`, e
rodar a restauração em cima — ou bootstrap com `--noauth` documentado pelo
operador. É a Fase 2.1 que entrega; DR-frio completo fica para o roadmap 2.3.

## Drill local (a prova de que a restauração funciona)

```sh
npm run test:backup
```

Sobe um stack isolado `micrologin-backup` (porta 3201, rede e volumes
próprios), registra um usuário, **faz backup, apaga o banco de verdade,
prova que o login passou a falhar**, restaura e exige que o **mesmo usuário**
volte a autenticar. Se a restauração não reconhecer o usuário, o teste falha —
é a definição de pronto da Fase 2.1. Ele também roda a poda em modo vazio e o
`--check`, garante que nada do material efêmero (chaves ES256, senhas de
dependências, passphrase do backup) sobrevive ao teardown.

A poda em si e o `--check` são cobertos por testes unitários
(`tests/unit/backup-prune.test.ts`) com nomes de arquivo fabricados cruzando
fronteiras de semana ISO — sem docker, rodam em CI.

## Checklist de itens do roadmap 2.1

- [x] `scripts/backup.sh`: mongodump → cifra (gpg AES-256) → `sha-data-<data>`
- [x] Retenção N diários + M semanais com poda automática
- [x] RPO/RTO definidos e documentados (medidos pelo drill)
- [x] `scripts/restore.sh` com drill real (banco apagado e restaurado, login)
- [x] `npm run test:backup` — gera dump, apaga o banco, restaura, valida usuário
- [x] Alerta de backup falho/velho: `--check` + `last-backup.json` + evento estruturado
- [x] Restauração pontual só com o dump criptografado (documentada acima; limitação DR-frio documentada)