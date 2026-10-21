<script lang="ts">
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import SchemaTagPicker from '$lib/components/SchemaTagPicker.svelte';
  import PeoplePickerModal from '$lib/modals/PeoplePickerModal.svelte';
  import { getPeopleThumbnailUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    defaultSmartRuleValue,
    hasSmartRuleValue,
    serializeSmartRules,
    smartRuleFieldMeta,
    smartRuleFields,
    type SmartRuleField,
  } from '$lib/utils/smart-album';
  import { AssetTypeEnum, getAllPeople, type PersonResponseDto, type SmartAlbumRulesDto } from '@immich/sdk';
  import { Button, DatePicker, Icon, IconButton, Input, modalManager, Select, type SelectOption } from '@immich/ui';
  import { mdiClose, mdiPlus } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    rules?: SmartAlbumRulesDto;
    valid?: boolean;
  };

  let {
    rules = $bindable({}),
    // eslint-disable-next-line no-useless-assignment, @typescript-eslint/no-unused-vars
    valid = $bindable(false),
  }: Props = $props();

  /**
   * `fields` = the enabled rule rows (each field may appear at most once, the
   * rules object is flat). `values` = the current draft value per field.
   */
  let fields = $state<SmartRuleField[]>(
    smartRuleFields.filter((field) => rules[field] !== undefined && rules[field] !== null),
  );
  let values = $state<Partial<SmartAlbumRulesDto>>({ ...rules });
  let people: PersonResponseDto[] = $state([]);
  let peopleById = $derived(new Map(people.map((person) => [person.id, person])));

  /**
   * Indexed writes on the flat rules object — `values[field]` would need the
   * value to satisfy every field type at once, so index through a record.
   */
  const setValue = (field: SmartRuleField, value: unknown) => {
    (values as Record<string, unknown>)[field] = value;
  };

  $effect(() => {
    rules = serializeSmartRules(fields, values);
    valid = fields.length > 0 && fields.every((field) => hasSmartRuleValue(values[field]));
  });

  onMount(async () => {
    try {
      const response = await getAllPeople({ withHidden: false });
      people = response.people;
    } catch (error) {
      handleError(error, $t('get_people_error'));
    }
  });

  const fieldOptions = (current: SmartRuleField): SelectOption<SmartRuleField>[] =>
    smartRuleFields.map((field) => ({
      label: $t(smartRuleFieldMeta[field].labelKey),
      value: field,
      disabled: field !== current && fields.includes(field),
    }));

  const addRule = () => {
    const field = smartRuleFields.find((candidate) => !fields.includes(candidate));
    if (!field) {
      return;
    }
    fields.push(field);
    const defaultValue = defaultSmartRuleValue(field);
    if (defaultValue !== undefined) {
      setValue(field, defaultValue);
    }
  };

  const removeRule = (index: number) => {
    const [field] = fields.splice(index, 1);
    delete values[field];
  };

  const changeField = (index: number, field: SmartRuleField) => {
    delete values[fields[index]];
    fields[index] = field;
    const defaultValue = defaultSmartRuleValue(field);
    if (defaultValue !== undefined) {
      setValue(field, defaultValue);
    }
  };

  const pickPeople = async () => {
    const selected = await modalManager.show(PeoplePickerModal, {
      multiple: true,
      excludedIds: values.personIds ?? [],
    });
    if (selected?.length) {
      values.personIds = [...(values.personIds ?? []), ...selected.map((person) => person.id)];
    }
  };

  const removePerson = (personId: string) => {
    values.personIds = (values.personIds ?? []).filter((id) => id !== personId);
  };

  const ratingOptions = $derived<SelectOption<string>[]>([
    { label: $t('rating_at_least', { values: { count: 5 } }), value: '5' },
    { label: $t('rating_at_least', { values: { count: 4 } }), value: '4' },
    { label: $t('rating_at_least', { values: { count: 3 } }), value: '3' },
    { label: $t('rating_at_least', { values: { count: 2 } }), value: '2' },
    { label: $t('rating_at_least', { values: { count: 1 } }), value: '1' },
    { label: $t('rating_any'), value: '-1' },
  ]);

  const typeOptions = $derived<SelectOption<AssetTypeEnum>[]>([
    { label: $t('image'), value: AssetTypeEnum.Image },
    { label: $t('video'), value: AssetTypeEnum.Video },
  ]);

  const booleanOptions = (field: 'isFavorite' | 'isNotInAlbum') =>
    [
      {
        label: $t(field === 'isFavorite' ? 'favorite' : 'not_in_any_album'),
        value: 'true',
      },
      {
        label: $t(field === 'isFavorite' ? 'not_favorited' : 'in_an_album'),
        value: 'false',
      },
    ] satisfies SelectOption<string>[];
</script>

<div class="flex flex-col gap-2" role="group" aria-label={$t('smart_album_rules')}>
  {#each fields as field, index (field)}
    {@const meta = smartRuleFieldMeta[field]}
    <div class="flex items-start gap-2 rounded-xl border border-subtle p-2">
      <div class="w-32 shrink-0 sm:w-40">
        <Select value={field} options={fieldOptions(field)} onChange={(value) => changeField(index, value)} />
      </div>
      <span class="shrink-0 pt-2 text-sm text-muted">{$t(meta.operatorKey)}</span>

      <div class="min-w-0 grow">
        {#if meta.kind === 'date'}
          <DatePicker
            bind:value={
              () => {
                const raw = values[field] as string | undefined;
                const parsed = raw ? DateTime.fromISO(raw) : undefined;
                return parsed?.isValid ? parsed : undefined;
              },
              (date) => setValue(field, date?.isValid ? (date.toUTC().toISO() ?? undefined) : undefined)
            }
          />
        {:else if meta.kind === 'text'}
          <Input
            bind:value={
              () => (values[field] as string | undefined) ?? '',
              (value) => setValue(field, value === '' ? undefined : value)
            }
          />
        {:else if meta.kind === 'rating'}
          <Select
            value={String(values.rating ?? 1)}
            options={ratingOptions}
            onChange={(value) => (values.rating = Number(value))}
          />
        {:else if meta.kind === 'type'}
          <Select
            value={values.type ?? AssetTypeEnum.Image}
            options={typeOptions}
            onChange={(value) => (values.type = value as AssetTypeEnum)}
          />
        {:else if meta.kind === 'boolean'}
          <Select
            value={String(values[field] ?? true)}
            options={booleanOptions(field as 'isFavorite' | 'isNotInAlbum')}
            onChange={(value) => setValue(field, value === 'true')}
          />
        {:else if meta.kind === 'people'}
          <div class="flex flex-wrap items-center gap-1.5 pt-1">
            {#each values.personIds ?? [] as personId (personId)}
              {@const person = peopleById.get(personId)}
              <span
                class="inline-flex items-center gap-1.5 rounded-full border border-subtle bg-subtle py-0.5 ps-1 pe-2 text-sm"
              >
                {#if person}
                  <ImageThumbnail
                    circle
                    url={getPeopleThumbnailUrl(person)}
                    altText={person.name}
                    widthStyle="1.25rem"
                    heightStyle="1.25rem"
                  />
                {/if}
                <span class="max-w-32 truncate">{person?.name || personId}</span>
                <button
                  type="button"
                  class="rounded-full p-0.5 hover:bg-gray-200 dark:hover:bg-gray-700"
                  aria-label={$t('remove')}
                  onclick={() => removePerson(personId)}
                >
                  <Icon icon={mdiClose} size="14" />
                </button>
              </span>
            {/each}
            <Button size="small" variant="ghost" leadingIcon={mdiPlus} onclick={pickPeople}>
              {$t('select_people')}
            </Button>
          </div>
        {:else if meta.kind === 'tags' && values.tagIds}
          <SchemaTagPicker bind:tagIds={values.tagIds} />
        {/if}
      </div>

      <IconButton
        icon={mdiClose}
        aria-label={$t('remove_rule')}
        title={$t('remove_rule')}
        variant="ghost"
        color="secondary"
        shape="round"
        size="small"
        onclick={() => removeRule(index)}
      />
    </div>
  {/each}

  <div class="pt-1">
    <Button
      size="small"
      variant="ghost"
      color="secondary"
      leadingIcon={mdiPlus}
      onclick={addRule}
      disabled={fields.length === smartRuleFields.length}
    >
      {$t('add_rule')}
    </Button>
  </div>
</div>
