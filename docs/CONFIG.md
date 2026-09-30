# Backup e restauração da configuração em vigor (Fase 2.3)

## Contratos operacionais

| Métrica | Valor | Como foi medido |
|---|---|---|
| RPO (config) | **24h** | cadência do agendador: 1 backup/dia (configurável com `--rpo-hours`); `--check` alerta backup velho/falho |
| Retenção | **14 diários** | `--retain-daily`, poda após cada backup e via `--prune-only` |
| Fonte da verdade | **o container em execução** | `scripts/test-config-backup.sh`: edita o env file sem redeployar e exige que o restore devolva o valor EM EXECUÇÃO (não o do disco editado) |
| Recovery path | `--match-tag`/`--match-image` | o archive sabe de qual imagem a configuração era, via metadata sem segredos |

## O que o backup é (e não é)

- É a captura, cifrada com **gpg AES-256 simétrico** (mesmo regime da Fase 2.1),
  de **o que está no ar**: o ambiente interpolado que o container executa
  (`docker inspect`, fonte da verdade), os arquivos que o compose monta e o
  env file original (ordem e comentários). O material de segredo é coletado por
  `docker cp` do container — nunca por leitura direta no host, onde os
  arquivos `600` do uid 1001/999 podem nem ser legíveis pelo operador.
- O manifest interno do archive guarda o **sha256 de cada arquivo** e o
  **dono/modo reais** (uid/gid), para o restore reproduzir não só os bytes,
  mas quem consegue lê-los dentro do container.
- **Não é** o `.env.prod` do disco: editar o arquivo sem redeployar deixa
  disco e container divergidos, e o que interessa para o rollback é o
  container. O restore sobrepõe o valor EM EXECUÇÃO de cada chave sobre o
  arquivo original, e acrescenta as chaves que o compose interpolava de outra
  origem (`${X}`/`${X:-...}`) e que estavam rodando.
- **Não é** substituição do backup do Mongo (D21) nem KMS/node de chave
  gerenciada (D23 — o que esta fase fecha é o buraco do rollback, D23 em
  `SEGURANCA.md`).

## Criar backup

```
scripts/backup-config.sh \
  --project micrologin --service auth-service \
  --env-file .env.prod \
  --backups-dir cfg-backups \
  --tag <tag> \
  --passphrase-file <arq>
```

A passphrase entra por **arquivo** (`--passphrase-file` ou
`CONFIG_BACKUP_PASSPHRASE_FILE`), nunca em argv: nada dela em `ps` do host nem
em log. `--check` (leitura de metadata, sem passphrase) é o gancho de alerta
de backup velho; `--prune-only` poda sem backup.

## Agendamento e alerta

Copie `backup-config.sh` e `restore-config.sh` para o servidor junto com o
deploy e agende, na cadência do RPO:

```
# cron diário — backup da configuração em vigor
0 3 * * *  /opt/micrologin/backup-config.sh --env-file /opt/micrologin/.env.prod \
             --backups-dir /var/lib/micrologin/config-backups \
             --tag cron --passphrase-file /etc/micrologin/config-backup.pass \
             >> /var/log/micrologin/config-backup.log 2>&1
# alerta cedo se o último backup velhar além do RPO
0 4 * * *  /opt/micrologin/backup-config.sh --check --backups-dir /var/lib/micrologin/config-backups --max-age 24
```

Um backup crondiário já é capturado em cima do que está no ar; o valor a mais
do deploy é que ele acopla a config à versão da imagem — o alvo do rollback.

## Restauração pontual (recovery path)

```
scripts/restore-config.sh \
  --match-tag  <tag-do-archive> \   # ou --match-image <ref>  ou  --archive <arq>
  --passphrase-file <arq> \
  --backups-dir cfg-backups \
  --target-dir <dir-do-compose> \
  --env-file-out .env.prod \
  --yes
```

Sem `--yes` é dryrun: valida sha/caminho e mostra o plano. O restore **só
aplica o que é íntegro** (sha256 de cada arquivo contra o manifest, recusa
caminho fora do alvo) e, ao aplicar, **reaplica dono/modo** dos segredos por
container descartável — o mesmo mecanismo dos geradores `--for-container`.

## O que os deploys fazem com isso

- `deploy.sh` captura a config no backup da versão (mesmo tag do backup de
  imagem) e, no rollback, restaura a config ANTES de subir o compose. Sem
  `CONFIG_BACKUP_PASSPHRASE_FILE` configurada, avisa e volta só a imagem.
- `remote-deploy.sh` **exige** a passphrase, taggeia a config pelo digest da
  versão (`deployed-<digest>`), restaura por essa tag antes do `up -d` no
  rollback e, após o sucesso, snapshota a config da versão nova.

## Drill local (a prova de que a restauração funciona)

```
scripts/test-config-backup.sh
```

Sobe um stack de teste com a **mesma topologia de mount de produção**
(`/run/secrets` e `/run/secrets/deps`), captura a config em execução, edita o
env file sem redeployar (o controle negativo), apaga env+segredos, restaura
pelo metadata da imagem (caminho que os deploys usam) e prova em runtime que
o app voltou a exibir a configuração capturada — não a do disco editado. O CI
tranca as invariantes em `tests/unit/config-backup-policy.test.ts`.

## Checklist de itens do roadmap 2.3

- [x] estende o material da "imagem anterior + deployed-version" com o backup
      do `.env.prod` e dos compose usados, lidos do container em execução
- [x] teste de que o deploy consegue restaurar imagem **e** configuração
      (`scripts/test-config-backup.sh` + gates de CI)