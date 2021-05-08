const { inject, uninject } = require('powercord/injector');
const { forceUpdateElement } = require('powercord/util');
const { Tooltip } = require('powercord/components');
const { Plugin } = require('powercord/entities');
const {
   getModuleByDisplayName,
   constants,
   getModule,
   i18n: { Messages },
   React
} = require('powercord/webpack');

const NavigableChannels = getModule(m => m.default?.displayName == 'NavigableChannels', false);
const ChannelItem = getModule(m => m.default?.displayName == 'ChannelItem', false);
const { getMutableGuildChannels } = getModule(['getMutableGuildChannels'], false);
const DiscordPermissions = getModule(['Permissions'], false).Permissions;
const { getCurrentUser } = getModule(['getCurrentUser'], false);
const Channel = getModule(m => m.prototype?.isManaged, false);
const Clickable = getModuleByDisplayName('Clickable', false);
const { getChannels } = getModule(['getChannels'], false);
const Permissions = getModule(['getHighestRole'], false);
const { getChannel } = getModule(['getChannel'], false);
const { actionIcon } = getModule(['actionIcon'], false);
const { getMember } = getModule(['getMember'], false);
const { iconItem } = getModule(['iconItem'], false);
const UnreadStore = getModule(['hasUnread'], false);
const Settings = require('./components/Settings');
const LockIcon = require('./components/Lock');

const channelTypes = {
   GUILD_TEXT: 'SELECTABLE',
   GUILD_VOICE: 'VOCAL',
   GUILD_ANNOUNCEMENT: 'SELECTABLE',
   GUILD_STORE: 'SELECTABLE',
};

module.exports = class ShowHiddenChannels extends Plugin {
   startPlugin() {
      powercord.api.settings.registerSettings('show-hidden-channels', {
         category: this.entityID,
         label: 'Show Hidden Channels',
         render: Settings
      });

      this.patches = [];
      this.cache = {};

      this.patch('shc-unread', UnreadStore, 'hasUnread', (args, res) => {
         return res && !this.isChannelHidden(args[0]);
      });

      this.patch('shc-mention-count', UnreadStore, 'getMentionCount', (args, res) => {
         return this.isChannelHidden(args[0]) ? 0 : res;
      });

      this.patch('shc-navigable-channels', NavigableChannels, 'default', (args, res) => {
         let props = res.props?.children?.props;
         if (!props) return res;

         let { guild } = props;
         let [channels, amount] = this.getHiddenChannels(guild);


         if (amount) {
            props.categories = Object.assign({}, props.categories);
            for (let cat in props.categories) props.categories[cat] = [].concat(props.categories[cat]);

            props.channels = Object.assign({}, props.channels);
            for (let type in props.channels) props.channels[type] = [].concat(props.channels[type]);

            let hiddenId = props.guild.id + "_hidden";

            delete props.categories[hiddenId];
            props.categories._categories = props.categories._categories.filter(n => n.channel.id != hiddenId);
            props.channels[constants.ChannelTypes.GUILD_CATEGORY] = props.channels[constants.ChannelTypes.GUILD_CATEGORY].filter(n => n.channel.id != hiddenId);

            let index = -1;
            for (let catId in props.categories) {
               if (catId != '_categories') {
                  props.categories[catId] = props.categories[catId].filter(n => !this.isChannelHidden(n.channel.id));
               }

               for (let channelObj of props.categories[catId]) {
                  if (channelObj.index > index) index = parseInt(channelObj.index);
               }
            }

            let hiddenCategory = null;
            if (!this.settings.get('sortNative', true)) {
               hiddenCategory = new Channel({
                  guild_id: props.guild.id,
                  id: hiddenId,
                  name: 'hidden',
                  type: constants.ChannelTypes.GUILD_CATEGORY
               });

               props.categories[hiddenId] = [];
               props.categories._categories.push({
                  channel: hiddenCategory,
                  index: ++index
               });

               props.channels[constants.ChannelTypes.GUILD_CATEGORY].push({
                  comparator: (props.channels[constants.ChannelTypes.GUILD_CATEGORY][props.channels[constants.ChannelTypes.GUILD_CATEGORY].length - 1] || { comparator: 0 }).comparator + 1,
                  channel: hiddenCategory
               });
            }

            for (let type in channels) {
               let channelType = channelTypes[constants.ChannelTypes[type]] || type;
               if (!Array.isArray(props.channels[channelType])) props.channels[channelType] = [];

               for (let channel of channels[type]) {
                  let hiddenChannel = new Channel(Object.assign({}, channel, {
                     parent_id: hiddenCategory ? hiddenId : channel.parent_id
                  }));

                  let parent_id = hiddenChannel.parent_id || 'null';

                  props.categories[parent_id].push({
                     channel: hiddenChannel,
                     index: hiddenChannel.position
                  });

                  props.channels[channelType].push({
                     comparator: hiddenChannel.position,
                     channel: hiddenChannel
                  });
               }
            }

            for (let parent_id in props.categories) this.sortArray(props.categories[parent_id], 'index');
            for (let channelType in props.channels) this.sortArray(props.channels[channelType], 'comparator');
         }

         return res;
      });

      NavigableChannels.default.displayName = 'NavigableChannels';

      this.patch('shc-channel-item', ChannelItem, 'default', (args, res) => {
         let instance = args[0];
         if (instance.channel && this.isChannelHidden(instance.channel.id)) {
            let children = res.props?.children?.props?.children[1]?.props?.children[1];
            if (children.props?.children) children.props.children = [
               <Tooltip text={Messages.CHANNEL_LOCKED_SHORT}>
                  <Clickable className={iconItem} style={{ display: 'block' }}>
                     <LockIcon className={actionIcon} />
                  </Clickable>
               </Tooltip>
            ];

            if (!(instance.channel?.type == constants.ChannelTypes.GUILD_VOICE && instance.props?.connected)) {
               let wrapper = res.props.children;
               if (wrapper) {
                  wrapper.props.onMouseDown = () => { };
                  wrapper.props.onMouseUp = () => { };
               }

               let mainContent = res.props?.children?.props?.children[1]?.props?.children[0];
               if (mainContent) {
                  mainContent.props.onClick = () => { };
                  mainContent.props.href = null;
               }
            }
         }
         return res;
      });

      ChannelItem.default.displayName = 'ChannelItem';

      this.forceUpdateAll();
   }

   pluginWillUnload() {
      powercord.api.settings.unregisterSettings('show-hidden-channels');
      for (const patch of this.patches) uninject(patch);
      this.forceUpdateAll();
   }

   sortArray(array, key, except) {
      if (key == null) return array;
      if (except === undefined) except = null;
      return array.sort((x, y) => {
         let xValue = x[key], yValue = y[key];
         if (xValue !== except) return xValue < yValue ? -1 : xValue > yValue ? 1 : 0;
      });
   }

   getHiddenChannels(guild) {
      if (!guild) return [{}, 0];
      let channels = {};

      let roles = (getMember(guild.id, getCurrentUser().id) || { roles: [] }).roles.length;
      let visible = (getChannels(guild.id) || { count: 0 });

      if (
         !this.cache[guild.id] ||
         this.cache[guild.id].visible != visible ||
         this.cache[guild.id].roles != roles
      ) {
         let all = getMutableGuildChannels(guild.id);

         for (let type in constants.ChannelTypes) {
            if (!Number.isNaN(Number(constants.ChannelTypes[type]))) {
               channels[constants.ChannelTypes[type]] = [];
            }
         }

         for (let id in all) {
            let channel = all[id];
            if (
               channel.guild_id == guild.id &&
               channel.type != constants.ChannelTypes.GUILD_CATEGORY &&
               channel.type != constants.ChannelTypes.DM &&
               !Permissions.can(DiscordPermissions.VIEW_CHANNEL, channel)
            ) channels[channel.type].push(channel);
         }
      } else {
         channels = this.cache[guild.id].hidden;
      }

      for (let type in channels) {
         channels[type] = channels[type].filter(c => getChannel(c.id));
      }

      this.cache[guild.id] = {
         hidden: channels,
         amount: Object.entries(channels).map(m => m[1]).flat().length,
         visible,
         roles
      };

      return [this.cache[guild.id].hidden, this.cache[guild.id].amount];
   }

   isChannelHidden(channelId) {
      let channel = getChannel(channelId);
      return channel &&
         this.cache[channel.guild_id] &&
         this.cache[channel.guild_id].hidden[channel.type] &&
         this.cache[channel.guild_id].hidden[channel.type].find(c => c.id == channel.id);
   }

   forceUpdateAll() {
      forceUpdateElement('div[id="channels"]');
   }

   patch(...args) {
      if (!args || !args[0] || typeof args[0] !== 'string') return;
      this.patches.push(args[0]);
      return inject(...args);
   }
};