<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { pushManager } from '$lib/managers/push-manager.svelte';
  import { getPushSubscriptionsQuery, getVapidPublicKeyQuery } from '$lib/queries/push.query';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import { isHttpError, updateMyPreferences, type PushSubscriptionResponseDto } from '@immich/sdk';
  import { Alert, Button, Field, Icon, IconButton, LoadingSpinner, Switch, Text, toastManager } from '@immich/ui';
  import { mdiCellphone, mdiTrashCanOutline } from '@mdi/js';
  import { createQuery } from '@tanstack/svelte-query';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  let pushNotificationsEnabled = $state(authManager.preferences.pushNotifications?.enabled ?? true);
  let albumInviteNotificationEnabled = $state(authManager.preferences.pushNotifications?.albumInvite ?? true);
  let albumUpdateNotificationEnabled = $state(authManager.preferences.pushNotifications?.albumUpdate ?? true);

  const vapidQuery = createQuery(() => ({ ...getVapidPublicKeyQuery(), enabled: pushManager.supported }));
  const subscriptionsQuery = createQuery(() => ({ ...getPushSubscriptionsQuery(), enabled: pushManager.supported }));

  let busy = $state(false);
  let testing = $state(false);
  let mounted = $state(false);

  onMount(() => {
    mounted = true;
    void pushManager.sync();
  });

  const currentSubscription = $derived(
    subscriptionsQuery.data?.find((subscription) => subscription.endpoint === pushManager.subscription?.endpoint),
  );
  const otherSubscriptions = $derived(
    (subscriptionsQuery.data ?? []).filter(
      (subscription) => subscription.endpoint !== pushManager.subscription?.endpoint,
    ),
  );
  const disabled = $derived(!pushNotificationsEnabled);
  // `null` publicKey (or 404 on an older server) means push is not configured.
  const pushNotConfigured = $derived(
    (vapidQuery.data !== undefined && vapidQuery.data.publicKey === null) ||
      (isHttpError(vapidQuery.error) && vapidQuery.error.status === 404),
  );

  const handleSubscribe = async () => {
    const publicKey = vapidQuery.data?.publicKey;
    if (!publicKey || busy) {
      return;
    }

    busy = true;
    try {
      const result = await pushManager.subscribe(publicKey);
      if (result === 'subscribed') {
        toastManager.primary($t('push_notifications_enabled_on_this_device'));
      } else if (result === 'denied') {
        toastManager.warning($t('push_notifications_permission_denied'));
      }
    } catch (error) {
      handleError(error, $t('errors.unable_to_enable_push_notifications'));
    } finally {
      busy = false;
    }
  };

  const handleUnsubscribe = async () => {
    busy = true;
    try {
      await pushManager.unsubscribe();
      toastManager.primary($t('push_notifications_disabled_on_this_device'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_disable_push_notifications'));
    } finally {
      busy = false;
    }
  };

  const handleRemoveSubscription = async (subscription: PushSubscriptionResponseDto) => {
    try {
      await pushManager.deleteSubscription(subscription.endpoint);
      toastManager.primary($t('push_subscription_removed'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_remove_push_subscription'));
    }
  };

  const handleTest = async () => {
    testing = true;
    try {
      const { delivered } = await pushManager.sendTest();
      if (delivered === 0) {
        toastManager.warning($t('push_test_notification_not_delivered'));
      } else {
        toastManager.primary($t('push_test_notification_sent'));
      }
    } catch (error) {
      handleError(error, $t('errors.unable_to_send_test_push_notification'));
    } finally {
      testing = false;
    }
  };

  const handleSave = async () => {
    try {
      const response = await updateMyPreferences({
        userPreferencesUpdateDto: {
          pushNotifications: {
            enabled: pushNotificationsEnabled,
            albumInvite: albumInviteNotificationEnabled,
            albumUpdate: albumUpdateNotificationEnabled,
          },
        },
      });

      authManager.setPreferences(response);
      toastManager.primary($t('saved_settings'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_settings'));
    }
  };

  const onsubmit = (event: Event) => {
    event.preventDefault();
  };
</script>

<section class="my-4">
  <div in:fade={{ duration: 500 }}>
    <div class="flex flex-col gap-6 sm:ms-8">
      {#if !mounted}
        <div class="flex justify-center">
          <LoadingSpinner />
        </div>
      {:else if !pushManager.supported}
        <Alert color="primary" icon={mdiCellphone}>
          <div class="flex flex-col gap-1">
            <Text>{$t('push_notifications_not_supported')}</Text>
            <Text size="small" color="muted">{$t('push_notifications_not_supported_description')}</Text>
          </div>
        </Alert>
      {:else if vapidQuery.isPending}
        <div class="flex justify-center">
          <LoadingSpinner />
        </div>
      {:else if vapidQuery.isError && !pushNotConfigured}
        <Alert color="danger" title={$t('errors.unable_to_load_push_configuration')} />
      {:else if pushNotConfigured}
        <Alert color="primary" icon={mdiCellphone}>
          <div class="flex flex-col gap-1">
            <Text>{$t('push_notifications_not_configured')}</Text>
            <Text size="small" color="muted">{$t('push_notifications_not_configured_description')}</Text>
          </div>
        </Alert>
      {:else}
        {#if pushManager.permission === 'denied'}
          <Alert color="warning" icon={mdiCellphone}>
            <div class="flex flex-col gap-1">
              <Text>{$t('push_notifications_blocked')}</Text>
              <Text size="small" color="muted">{$t('push_notifications_blocked_description')}</Text>
            </div>
          </Alert>
        {/if}

        <div>
          <Text class="mb-2" fontWeight="medium" size="tiny" color="primary">
            {$t('current_device')}
          </Text>
          <div class="flex w-full flex-row items-center gap-3">
            <Icon icon={mdiCellphone} size="32" class="text-primary" aria-hidden />
            <div class="flex grow flex-col dark:text-white">
              <span class="text-sm">
                {pushManager.subscription
                  ? $t('push_notifications_this_device_subscribed')
                  : $t('push_notifications_this_device_not_subscribed')}
              </span>
              {#if currentSubscription}
                <span class="text-xs text-gray-500 dark:text-gray-400">
                  {DateTime.fromISO(currentSubscription.createdAt, { locale: $locale }).toLocaleString(
                    DateTime.DATETIME_MED,
                    { locale: $locale },
                  )}
                </span>
              {/if}
            </div>
            <div class="flex flex-row gap-2">
              {#if pushManager.subscription}
                <Button shape="round" size="small" variant="ghost" loading={testing} onclick={handleTest}>
                  {$t('push_notifications_send_test')}
                </Button>
                <Button
                  shape="round"
                  size="small"
                  color="danger"
                  variant="ghost"
                  loading={busy}
                  onclick={handleUnsubscribe}
                >
                  {$t('push_notifications_disable_on_this_device')}
                </Button>
              {:else}
                <Button
                  shape="round"
                  size="small"
                  loading={busy}
                  disabled={pushManager.permission === 'denied'}
                  onclick={handleSubscribe}
                >
                  {$t('push_notifications_enable_on_this_device')}
                </Button>
              {/if}
            </div>
          </div>
        </div>

        {#if otherSubscriptions.length > 0}
          <div>
            <Text class="mb-2" fontWeight="medium" size="tiny" color="primary">
              {$t('other_devices')}
            </Text>
            {#each otherSubscriptions as subscription, index (subscription.id)}
              <div class="flex w-full flex-row items-center gap-3">
                <Icon icon={mdiCellphone} size="32" class="text-primary" aria-hidden />
                <div class="flex grow flex-col dark:text-white">
                  <span class="text-sm" title={subscription.userAgent ?? ''}>
                    {subscription.userAgent || $t('unknown')}
                  </span>
                  <span class="text-xs text-gray-500 dark:text-gray-400">
                    {DateTime.fromISO(subscription.createdAt, { locale: $locale }).toLocaleString(
                      DateTime.DATETIME_MED,
                      { locale: $locale },
                    )}
                  </span>
                </div>
                <IconButton
                  color="danger"
                  variant="ghost"
                  shape="round"
                  icon={mdiTrashCanOutline}
                  aria-label={$t('remove')}
                  size="small"
                  onclick={() => handleRemoveSubscription(subscription)}
                />
              </div>
              {#if index !== otherSubscriptions.length - 1}
                <hr class="my-3" />
              {/if}
            {/each}
          </div>
        {/if}
      {/if}

      <form autocomplete="off" {onsubmit}>
        <div class="flex flex-col gap-6">
          <Field label={$t('enable')} description={$t('push_notification_toggle_setting_description')}>
            <Switch bind:checked={pushNotificationsEnabled} />
          </Field>

          <Field
            label={$t('album_added')}
            description={$t('push_album_added_notification_setting_description')}
            {disabled}
          >
            <Switch bind:checked={albumInviteNotificationEnabled} />
          </Field>

          <Field
            label={$t('album_updated')}
            description={$t('push_album_updated_notification_setting_description')}
            {disabled}
          >
            <Switch bind:checked={albumUpdateNotificationEnabled} />
          </Field>
        </div>

        <div class="mt-4 flex justify-end">
          <Button shape="round" type="submit" size="small" onclick={() => handleSave()}>{$t('save')}</Button>
        </div>
      </form>
    </div>
  </div>
</section>
