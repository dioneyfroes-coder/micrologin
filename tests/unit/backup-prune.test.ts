import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Backup e retenção do MongoDB (Fase 2.1).
 *
 * A poda ("mantém N diários + o mais novo de M semanas ISO") não pode esperar
 * por dejetos de semanas diferentes em um teste de integração real — isso
 * levaria dias. Estes testes fabricam nomes de arquivo com timestamps que
 * cruzam fronteiras de semana e provam matematicamente o que fica e o que sai.
 *
 * O `--check` (alerta de backup velho) recebe um manifest fabricado e prova as
 * três saídas: dentro da janela, velho demais, e sem manifest nenhum.
 * Nenhum destes caminhos precisa de docker ou gpg — são só operações de
 * diretório, e é justamente por isso que testam rápido.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BACKUP = resolve(ROOT, 'scripts/backup.sh');

const run = (script: string, args: string[]): { status: number; stdout: string; stderr: string } => {
  const executed = spawnSync('bash', [script, ...args], { encoding: 'utf8' });
  return {
    status: executed.status ?? 1,
    stdout: executed.stdout ?? '',
    stderr: executed.stderr ?? ''
  };
};

const freshDir = (): string => mkdtempSync(join(tmpdir(), 'backup-prune-'));

const file = (dir: string, stamp: string): string => {
  const name = `sha-data-${stamp}.archive.gpg`;
  writeFileSync(join(dir, name), 'x');
  return name;
};

const filesOf = (dir: string): string[] =>
  readdirSync(dir)
    .filter((name) => name.startsWith('sha-data-') && name.endsWith('.archive.gpg'))
    .sort();

const prune = (dir: string, daily: number, weekly: number): { status: number; stderr: string } =>
  run(BACKUP, ['--prune-only', '--backups-dir', dir, '--retain-daily', String(daily), '--retain-weekly', String(weekly)]);

describe('retenção de backups (diários + semanais)', () => {
  it('cruzando semanas ISO: mantém os 2 mais novos + o mais novo de cada uma das 2 últimas semanas', () => {
    const dir = freshDir();
    // Semanas: 2026-W31 (julho), W36 (set), W39, W40.
    file(dir, '20260729T120000Z');
    file(dir, '20260830T120000Z'); // W36
    file(dir, '20260901T120000Z'); // W36
    file(dir, '20260925T120000Z'); // W39
    file(dir, '20260928T120000Z'); // W40
    file(dir, '20260929T120000Z'); // W40
    file(dir, '20260930T120000Z'); // W40

    const result = prune(dir, 2, 2);
    expect(result.status).toBe(0);
    // daily = 0929, 0930; weekly = 0930 (W40) + 0925 (W39, o mais novo não-diário
    // fora da janela diária). Tudo o mais sai.
    expect(filesOf(dir)).toEqual([
      'sha-data-20260925T120000Z.archive.gpg',
      'sha-data-20260929T120000Z.archive.gpg',
      'sha-data-20260930T120000Z.archive.gpg'
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('um arquivo por semana guardado antes da diária: a poda nunca apaga o único representante', () => {
    const dir = freshDir();
    file(dir, '20260406T120000Z'); // W15
    file(dir, '20260701T120000Z'); // W27
    file(dir, '20260730T120000Z'); // W31
    file(dir, '20260831T120000Z'); // W36
    file(dir, '20260901T120000Z'); // W36
    file(dir, '20260925T120000Z'); // W39
    file(dir, '20260928T120000Z'); // W40
    file(dir, '20260929T120000Z'); // W40
    file(dir, '20260930T120000Z'); // W40

    const result = prune(dir, 3, 1);
    expect(result.status).toBe(0);
    // daily = 0928, 0929, 0930; weekly = 0930 (W40, única semana guardada).
    expect(filesOf(dir)).toEqual([
      'sha-data-20260928T120000Z.archive.gpg',
      'sha-data-20260929T120000Z.archive.gpg',
      'sha-data-20260930T120000Z.archive.gpg'
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('menos arquivos que a retenção: nada é apagado', () => {
    const dir = freshDir();
    file(dir, '20260930T120000Z');

    expect(prune(dir, 7, 4).status).toBe(0);
    expect(filesOf(dir)).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('fronteira de ano ISO: 29/dez/2026 a 01/jan/2027 estão na W53 de 2026 (um só representante)', () => {
    const dir = freshDir();
    file(dir, '20261229T120000Z'); // W53 de 2026
    file(dir, '20261231T120000Z'); // W53 de 2026
    file(dir, '20270101T120000Z'); // W53 de 2026 — o mais novo da semana
    file(dir, '20270105T120000Z'); // W01 de 2027

    expect(prune(dir, 2, 2).status).toBe(0);
    // daily = 0101, 0105; weekly = 0105 (W01) + 0101 (W53, representante da
    // semana inteira que termina em 2026). 1229 e 1231 são W53 mais antigos,
    // então saem — a semana ISO não se divide por fronteira de ano civil.
    expect(filesOf(dir)).toEqual([
      'sha-data-20270101T120000Z.archive.gpg',
      'sha-data-20270105T120000Z.archive.gpg'
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('diretório vazio é idempotente', () => {
    const dir = freshDir();
    expect(prune(dir, 5, 2).status).toBe(0);
    expect(filesOf(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('alertas de backup (--check)', () => {
  const manifest = (dir: string, epoch: number): void =>
    writeFileSync(join(dir, 'last-backup.json'), `{"event":"backup_ok","epoch":${epoch},"rpo_h":24}\n`);

  it('manifest recente: dentro da janela, exit 0', () => {
    const dir = freshDir();
    manifest(dir, Math.floor(Date.now() / 1000));
    const result = run(BACKUP, ['--check', '--backups-dir', dir]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('backup_fresh');
    rmSync(dir, { recursive: true, force: true });
  });

  it('manifest mais velho que a janela: alerta via stderr estruturado, exit 1', () => {
    const dir = freshDir();
    manifest(dir, Math.floor(Date.now() / 1000) - 90000); // 25h atrás
    const result = run(BACKUP, ['--check', '--backups-dir', dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('backup_stale');
    expect(result.stderr).toContain('too_old');
    rmSync(dir, { recursive: true, force: true });
  });

  it('sem manifest nenhum: nunca houve backup, exit 1', () => {
    const dir = freshDir();
    const result = run(BACKUP, ['--check', '--backups-dir', dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no_manifest');
    rmSync(dir, { recursive: true, force: true });
  });

  it('--max-age define a janela do alerta (mais curta que o RPO)', () => {
    const dir = freshDir();
    manifest(dir, Math.floor(Date.now() / 1000) - 7200); // 2h atrás
    const result = run(BACKUP, ['--check', '--backups-dir', dir, '--max-age', '1']);
    expect(result.status).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('validação de uso do backup.sh', () => {
  it('--prune-only e --check são mutuamente exclusivos (exit 2)', () => {
    const dir = freshDir();
    const result = run(BACKUP, ['--prune-only', '--check', '--backups-dir', dir]);
    expect(result.status).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('flag desconhecida: exit 2', () => {
    const dir = freshDir();
    const result = run(BACKUP, ['--nao-existe', '--backups-dir', dir]);
    expect(result.status).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('retain/rpo não inteiros: exit 2', () => {
    const dir = freshDir();
    expect(run(BACKUP, ['--prune-only', '--backups-dir', dir, '--retain-daily', 'abc']).status).toBe(2);
    expect(run(BACKUP, ['--prune-only', '--backups-dir', dir, '--retain-daily', '0']).status).toBe(2);
    expect(run(BACKUP, ['--prune-only', '--backups-dir', dir, '--retain-weekly', '-1']).status).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('sem passphrase em modo backup: exit 2 (sem precisar de docker)', () => {
    const dir = freshDir();
    const result = run(BACKUP, ['--backups-dir', dir]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('passphrase');
    rmSync(dir, { recursive: true, force: true });
  });
});
