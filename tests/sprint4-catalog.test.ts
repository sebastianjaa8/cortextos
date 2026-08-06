import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  browseCatalog,
  installCommunityItem,
  prepareSubmission,
  submitCommunityItem,
} from '../src/bus/catalog.js';

describe('Sprint 4: Community Catalog', () => {
  const testDir = join(tmpdir(), `cortextos-sprint4-${Date.now()}`);
  const frameworkRoot = join(testDir, 'framework');
  const ctxRoot = join(testDir, 'ctx');

  const sampleCatalog = {
    version: '1.0.0',
    updated_at: '2026-03-28T18:00:00Z',
    items: [
      {
        name: 'claude-api-helper',
        description: 'Build applications with the Claude API',
        author: 'anthropic',
        type: 'skill',
        version: '1.0.0',
        tags: ['api', 'sdk'],
        review_status: 'official',
        dependencies: [],
        install_path: 'skills/claude-api-helper',
        submitted_at: '2026-03-28T18:00:00Z',
      },
      {
        name: 'prompt-engineering',
        description: 'Techniques for writing effective prompts',
        author: 'anthropic',
        type: 'skill',
        version: '1.0.0',
        tags: ['prompting', 'techniques'],
        review_status: 'official',
        dependencies: [],
        install_path: 'skills/prompt-engineering',
        submitted_at: '2026-03-28T18:00:00Z',
      },
      {
        name: 'research-agent',
        description: 'An agent template for research tasks',
        author: 'community-user',
        type: 'agent',
        version: '1.0.0',
        tags: ['research', 'analysis'],
        review_status: 'community',
        dependencies: [],
        install_path: 'agents/research-agent',
        submitted_at: '2026-03-28T18:00:00Z',
      },
    ],
  };

  beforeEach(() => {
    mkdirSync(join(frameworkRoot, 'community'), { recursive: true });
    mkdirSync(ctxRoot, { recursive: true });
    writeFileSync(
      join(frameworkRoot, 'community', 'catalog.json'),
      JSON.stringify(sampleCatalog, null, 2),
      'utf-8',
    );

    // Create source dirs for installable items
    const skillDir = join(frameworkRoot, 'community', 'skills', 'claude-api-helper');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: claude-api-helper\n---\nContent here', 'utf-8');
    writeFileSync(join(skillDir, 'README.md'), '# Claude API Helper', 'utf-8');

    const promptDir = join(frameworkRoot, 'community', 'skills', 'prompt-engineering');
    mkdirSync(promptDir, { recursive: true });
    writeFileSync(join(promptDir, 'SKILL.md'), '---\nname: prompt-engineering\n---\nPrompt content', 'utf-8');

    const agentDir = join(frameworkRoot, 'community', 'agents', 'research-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'AGENTS.md'), '# Research Agent', 'utf-8');
    writeFileSync(join(agentDir, 'CLAUDE.md'), '@AGENTS.md\n', 'utf-8');
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('browseCatalog', () => {
    it('returns all items when no filters', () => {
      const result = browseCatalog(frameworkRoot, ctxRoot);
      expect(result.status).toBe('ok');
      expect(result.count).toBe(3);
      expect(result.items.length).toBe(3);
    });

    it('filters by type', () => {
      const result = browseCatalog(frameworkRoot, ctxRoot, { type: 'skill' });
      expect(result.count).toBe(2);
      expect(result.items.every(i => i.type === 'skill')).toBe(true);
    });

    it('filters by tag', () => {
      const result = browseCatalog(frameworkRoot, ctxRoot, { tag: 'api' });
      expect(result.count).toBe(1);
      expect(result.items[0].name).toBe('claude-api-helper');
    });

    it('filters by search query (case-insensitive)', () => {
      const result = browseCatalog(frameworkRoot, ctxRoot, { search: 'prompt' });
      expect(result.count).toBe(1);
      expect(result.items[0].name).toBe('prompt-engineering');
    });

    it('combines filters', () => {
      const result = browseCatalog(frameworkRoot, ctxRoot, { type: 'skill', tag: 'sdk' });
      expect(result.count).toBe(1);
      expect(result.items[0].name).toBe('claude-api-helper');
    });

    it('marks installed items', () => {
      writeFileSync(
        join(ctxRoot, '.installed-community.json'),
        JSON.stringify({ 'claude-api-helper': { version: '1.0.0', type: 'skill', installed_at: '2026-03-28', path: '/tmp/test' } }),
        'utf-8',
      );
      const result = browseCatalog(frameworkRoot, ctxRoot);
      const apiItem = result.items.find(i => i.name === 'claude-api-helper');
      const promptItem = result.items.find(i => i.name === 'prompt-engineering');
      expect(apiItem?.installed).toBe(true);
      expect(promptItem?.installed).toBe(false);
    });

    it('returns error when catalog not found', () => {
      const result = browseCatalog('/nonexistent', ctxRoot);
      expect(result.status).toBe('error');
      expect(result.error).toContain('not found');
    });

    it('returns empty when no items in catalog', () => {
      writeFileSync(
        join(frameworkRoot, 'community', 'catalog.json'),
        JSON.stringify({ items: [] }),
        'utf-8',
      );
      const result = browseCatalog(frameworkRoot, ctxRoot);
      expect(result.status).toBe('empty');
      expect(result.count).toBe(0);
    });
  });

  describe('installCommunityItem', () => {
    it('installs a skill to agent skills directory', () => {
      const agentDir = join(testDir, 'agent');
      mkdirSync(agentDir, { recursive: true });
      const result = installCommunityItem(frameworkRoot, ctxRoot, 'claude-api-helper', { agentDir });
      expect(result.status).toBe('installed');
      expect(result.name).toBe('claude-api-helper');
      expect(result.version).toBe('1.0.0');
      expect(result.file_count).toBe(2);

      // Verify files were copied to the Claude Code harness location
      const targetSkillMd = join(agentDir, '.claude', 'skills', 'claude-api-helper', 'SKILL.md');
      expect(existsSync(targetSkillMd)).toBe(true);

      // Verify installed record
      const installed = JSON.parse(readFileSync(join(ctxRoot, '.installed-community.json'), 'utf-8'));
      expect(installed['claude-api-helper']).toBeDefined();
      expect(installed['claude-api-helper'].version).toBe('1.0.0');
    });

    it('dry-run lists files without installing', () => {
      const result = installCommunityItem(frameworkRoot, ctxRoot, 'claude-api-helper', { dryRun: true });
      expect(result.status).toBe('dry_run');
      expect(result.file_count).toBe(2);
      expect(result.files).toContain('SKILL.md');
      expect(result.files).toContain('README.md');

      // Nothing installed
      expect(existsSync(join(ctxRoot, '.installed-community.json'))).toBe(false);
    });

    it('rejects invalid item names', () => {
      const result = installCommunityItem(frameworkRoot, ctxRoot, '../evil');
      expect(result.status).toBe('error');
      expect(result.error).toContain('invalid item name');
    });

    it('returns error for unknown items', () => {
      const result = installCommunityItem(frameworkRoot, ctxRoot, 'nonexistent');
      expect(result.status).toBe('error');
      expect(result.error).toContain('not found in catalog');
    });

    it('detects already installed items', () => {
      const agentDir = join(testDir, 'agent');
      // First install
      installCommunityItem(frameworkRoot, ctxRoot, 'claude-api-helper', { agentDir });
      // Second install
      const result = installCommunityItem(frameworkRoot, ctxRoot, 'claude-api-helper', { agentDir });
      expect(result.status).toBe('already_exists');
    });

    it('installs agent templates to templates/personas/', () => {
      const result = installCommunityItem(frameworkRoot, ctxRoot, 'research-agent');
      expect(result.status).toBe('installed');
      expect(result.target).toContain(join('templates', 'personas', 'research-agent'));
    });

    it('rejects path traversal in install_path', () => {
      // Modify catalog with malicious install_path
      const maliciousCatalog = {
        ...sampleCatalog,
        items: [{
          ...sampleCatalog.items[0],
          name: 'evil-item',
          install_path: '../../../etc/passwd',
        }],
      };
      writeFileSync(
        join(frameworkRoot, 'community', 'catalog.json'),
        JSON.stringify(maliciousCatalog),
        'utf-8',
      );
      const result = installCommunityItem(frameworkRoot, ctxRoot, 'evil-item');
      expect(result.status).toBe('error');
      expect(result.error).toContain('path traversal');
    });
  });

  describe('prepareSubmission', () => {
    let sourceDir: string;

    beforeEach(() => {
      sourceDir = join(testDir, 'my-skill');
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, 'SKILL.md'), '---\nname: my-skill\n---\nA custom skill', 'utf-8');
      writeFileSync(join(sourceDir, 'helper.ts'), 'export function help() {}', 'utf-8');
    });

    it('reports clean_partial, not clean, when the caller supplied no names to scan for', () => {
      // THIS TEST USED TO ASSERT 'clean' AND THAT WAS THE DEFECT. Calling without orgContext or
      // userNames disables the company-name and person-name checks entirely, and the old status
      // said `clean` regardless — a scanner reporting a complete pass having never run two of its
      // checks. The suite was green while concealing it, in the scanner that gates PUBLIC
      // submission. A partial scan must not be able to spell itself the same as a full one.
      const result = prepareSubmission(ctxRoot, 'skill', sourceDir, 'my-skill');
      expect(result.status).toBe('clean_partial');
      expect(result.name).toBe('my-skill');
      expect(result.file_count).toBe(2);
      expect(result.pii_detected.length).toBe(0);
      expect(existsSync(result.staging_dir)).toBe(true);
      // The blind spot is named, not merely implied by a status string.
      expect(result.checks_skipped.map((c) => c.check).sort()).toEqual(['company_name', 'user_name']);
      expect(result.checks_run).toContain('email');
    });

    it('reports a plain clean ONLY when every check actually ran', () => {
      // The must-reach-clean control. A status that can never be plain `clean` would be as useless
      // as one that is always `clean`; it would just be annoying instead of dangerous.
      const result = prepareSubmission(ctxRoot, 'skill', sourceDir, 'my-skill', {
        orgContext: { name: 'Nonmatching Org' },
        userNames: ['Nonmatching Person'],
      });
      expect(result.status).toBe('clean');
      expect(result.checks_skipped).toEqual([]);
      expect(result.checks_run).toContain('company_name');
      expect(result.checks_run).toContain('user_name');
    });

    it('detects email addresses', () => {
      writeFileSync(join(sourceDir, 'config.ts'), 'const email = "user@example.com"', 'utf-8');
      const result = prepareSubmission(ctxRoot, 'skill', sourceDir, 'my-skill');
      expect(result.status).toBe('pii_detected');
      expect(result.pii_detected.some(p => p.includes('email_address'))).toBe(true);
    });

    it('detects credential patterns', () => {
      writeFileSync(join(sourceDir, 'secret.ts'), 'const key = "sk-abc123"', 'utf-8');
      const result = prepareSubmission(ctxRoot, 'skill', sourceDir, 'my-skill');
      expect(result.status).toBe('pii_detected');
      expect(result.pii_detected.some(p => p.includes('credential_pattern'))).toBe(true);
    });

    it('detects deployment URLs', () => {
      writeFileSync(join(sourceDir, 'deploy.ts'), 'const url = "https://myapp.railway.app"', 'utf-8');
      const result = prepareSubmission(ctxRoot, 'skill', sourceDir, 'my-skill');
      expect(result.status).toBe('pii_detected');
      expect(result.pii_detected.some(p => p.includes('deployment_url'))).toBe(true);
    });

    it('detects telegram chat IDs', () => {
      writeFileSync(join(sourceDir, 'tg.ts'), 'chat_id: 123456789', 'utf-8');
      const result = prepareSubmission(ctxRoot, 'skill', sourceDir, 'my-skill');
      expect(result.status).toBe('pii_detected');
      expect(result.pii_detected.some(p => p.includes('telegram_chat_id'))).toBe(true);
    });

    it('detects company names when provided', () => {
      writeFileSync(join(sourceDir, 'about.md'), 'Built for Acme Corp', 'utf-8');
      const result = prepareSubmission(ctxRoot, 'skill', sourceDir, 'my-skill', {
        orgContext: { name: 'Acme Corp' },
      });
      expect(result.status).toBe('pii_detected');
      expect(result.pii_detected.some(p => p.includes('company_name'))).toBe(true);
    });

    it('detects user names when provided', () => {
      writeFileSync(join(sourceDir, 'readme.md'), 'Created by John Smith', 'utf-8');
      const result = prepareSubmission(ctxRoot, 'skill', sourceDir, 'my-skill', {
        userNames: ['John Smith'],
      });
      expect(result.status).toBe('pii_detected');
      expect(result.pii_detected.some(p => p.includes('user_name:John Smith'))).toBe(true);
    });

    it('dry-run cleans up staging dir', () => {
      const result = prepareSubmission(ctxRoot, 'skill', sourceDir, 'my-skill', { dryRun: true });
      expect(result.status).toBe('clean_partial'); // no names supplied — see the status test above
      expect(existsSync(result.staging_dir)).toBe(false);
    });

    it('rejects invalid item names', () => {
      const result = prepareSubmission(ctxRoot, 'skill', sourceDir, '../evil');
      expect(result.status).toBe('error');
    });
  });

  describe('submitCommunityItem', () => {
    beforeEach(() => {
      // Create a staged submission
      const stagingDir = join(ctxRoot, 'community-staging', 'my-skill');
      mkdirSync(stagingDir, { recursive: true });
      writeFileSync(join(stagingDir, 'SKILL.md'), '---\nname: my-skill\n---\nContent', 'utf-8');
    });

    it('copies staged files and updates catalog', () => {
      const result = submitCommunityItem(frameworkRoot, ctxRoot, 'my-skill', 'skill', 'A great skill');
      expect(result.status).toBe('submitted');
      expect(result.name).toBe('my-skill');

      // Verify files copied to community dir
      expect(existsSync(join(frameworkRoot, 'community', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);

      // Verify catalog updated
      const catalog = JSON.parse(readFileSync(join(frameworkRoot, 'community', 'catalog.json'), 'utf-8'));
      const newItem = catalog.items.find((i: any) => i.name === 'my-skill');
      expect(newItem).toBeDefined();
      expect(newItem.description).toBe('A great skill');
      expect(newItem.type).toBe('skill');
      expect(newItem.review_status).toBe('community');
      expect(newItem.install_path).toBe('skills/my-skill');
    });

    it('cleans up staging after submit', () => {
      submitCommunityItem(frameworkRoot, ctxRoot, 'my-skill', 'skill', 'Test');
      expect(existsSync(join(ctxRoot, 'community-staging', 'my-skill'))).toBe(false);
    });

    it('dry-run does not modify files', () => {
      const result = submitCommunityItem(frameworkRoot, ctxRoot, 'my-skill', 'skill', 'Test', { dryRun: true });
      expect(result.status).toBe('dry_run');
      expect(result.file_count).toBe(1);
      // Staging still exists
      expect(existsSync(join(ctxRoot, 'community-staging', 'my-skill'))).toBe(true);
      // Catalog unchanged
      const catalog = JSON.parse(readFileSync(join(frameworkRoot, 'community', 'catalog.json'), 'utf-8'));
      expect(catalog.items.find((i: any) => i.name === 'my-skill')).toBeUndefined();
    });

    it('returns error when no staged submission exists', () => {
      const result = submitCommunityItem(frameworkRoot, ctxRoot, 'nonexistent', 'skill', 'Test');
      expect(result.status).toBe('error');
      expect(result.hint).toContain('prepare-submission');
    });

    it('rejects invalid types', () => {
      const result = submitCommunityItem(frameworkRoot, ctxRoot, 'my-skill', 'invalid', 'Test');
      expect(result.status).toBe('error');
      expect(result.error).toContain('invalid type');
    });

    it('rejects invalid item names', () => {
      const result = submitCommunityItem(frameworkRoot, ctxRoot, '../evil', 'skill', 'Test');
      expect(result.status).toBe('error');
      expect(result.error).toContain('invalid item name');
    });

    it('re-submitting the same item name updates the existing catalog entry instead of duplicating it', () => {
      submitCommunityItem(frameworkRoot, ctxRoot, 'my-skill', 'skill', 'First description');

      // Re-stage the same item (submit consumes/removes the staging dir each time)
      const stagingDir = join(ctxRoot, 'community-staging', 'my-skill');
      mkdirSync(stagingDir, { recursive: true });
      writeFileSync(join(stagingDir, 'SKILL.md'), '---\nname: my-skill\n---\nUpdated content', 'utf-8');

      const result = submitCommunityItem(frameworkRoot, ctxRoot, 'my-skill', 'skill', 'Second description');
      expect(result.status).toBe('submitted');

      const catalog = JSON.parse(readFileSync(join(frameworkRoot, 'community', 'catalog.json'), 'utf-8'));
      const matches = catalog.items.filter((i: any) => i.name === 'my-skill');
      expect(matches.length).toBe(1);
      expect(matches[0].description).toBe('Second description');
    });

    it('preserves curated fields (tags, review_status, dependencies) across a re-submit', () => {
      submitCommunityItem(frameworkRoot, ctxRoot, 'my-skill', 'skill', 'First description');
      const catalogPath = join(frameworkRoot, 'community', 'catalog.json');
      const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
      const entry = catalog.items.find((i: any) => i.name === 'my-skill');
      entry.tags = ['curated-tag'];
      entry.review_status = 'official';
      entry.dependencies = ['some-dep'];
      writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), 'utf-8');

      const stagingDir = join(ctxRoot, 'community-staging', 'my-skill');
      mkdirSync(stagingDir, { recursive: true });
      writeFileSync(join(stagingDir, 'SKILL.md'), '---\nname: my-skill\n---\nUpdated content', 'utf-8');
      submitCommunityItem(frameworkRoot, ctxRoot, 'my-skill', 'skill', 'Second description');

      const after = JSON.parse(readFileSync(catalogPath, 'utf-8'));
      const updated = after.items.find((i: any) => i.name === 'my-skill');
      expect(updated.tags).toEqual(['curated-tag']);
      expect(updated.review_status).toBe('official');
      expect(updated.dependencies).toEqual(['some-dep']);
      expect(updated.description).toBe('Second description');
    });
  });
});
