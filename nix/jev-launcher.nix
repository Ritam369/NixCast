# Jev Launcher for NixOS — optional declarative bits.
#
# The extension itself is installed into your home directory by install.sh
# (a symlink the shell reads), so NixOS does not have to build anything. This
# module covers the parts that are nicer to declare than to script:
#
#   * the packages the launcher and its executor need at runtime
#   * Alt+Space freed from GNOME's window menu, so the shortcut survives a
#     fresh dconf
#   * the brain as a user service that starts with your session
#
# Import it from configuration.nix:
#
#     imports = [ ./jev-launcher-nixos/nix/jev-launcher.nix ];
#     services.jev-launcher = {
#       enable = true;
#       user = "ritam";
#       repoDir = "/home/ritam/jev-launcher-nixos";
#     };
#
# then, as always: sudo nixos-rebuild switch

{ config, lib, pkgs, ... }:

let
  cfg = config.services.jev-launcher;
in
{
  options.services.jev-launcher = {
    enable = lib.mkEnableOption "the Jev Launcher brain (Bun) and its GNOME integration";

    user = lib.mkOption {
      type = lib.types.str;
      description = "User whose session runs the launcher.";
    };

    repoDir = lib.mkOption {
      type = lib.types.str;
      description = "Absolute path to this repository's checkout.";
      example = "/home/ritam/jev-launcher-nixos";
    };

    bunPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.bun;
      defaultText = lib.literalExpression "pkgs.bun";
      description = "Bun used to run the brain.";
    };

    unbindAltSpace = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Free Alt+Space from GNOME's "activate window menu" binding, which
        otherwise swallows the launcher's shortcut. install.sh does this at
        runtime; declaring it here makes it survive a reset dconf.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # Runtime dependencies of the executor and the indexers. sqlite3 is *not*
    # needed: Bun ships its own SQLite binding for reading browser histories.
    # glib.dev is here because glib-compile-schemas lives in glib's dev
    # output on nixpkgs; install.sh uses it to recompile the extension's
    # schema and falls back to the committed gschemas.compiled without it.
    environment.systemPackages = with pkgs; [
      cfg.bunPackage
      wl-clipboard      # calculator results and other copies
      xdg-utils         # xdg-open, used to open files and urls
      glib              # gsettings
      glib.dev          # glib-compile-schemas
      networkmanager    # nmcli radio wifi off/on
      gnome-shell       # gnome-extensions, used by install.sh
    ];

    # The GNOME custom shortcuts database. Only this one key is written, so
    # your other shortcuts are untouched.
    programs.dconf.profiles.user.databases = lib.mkIf cfg.unbindAltSpace [
      {
        settings."org/gnome/desktop/wm/keybindings" = {
          activate-window-menu = lib.gvariant.mkEmptyArray (lib.gvariant.type.string);
        };
      }
    ];

    # A user service, so the brain starts with the graphical session and is
    # restarted if it ever exits.
    systemd.services.jev-brain = {
      description = "Jev Launcher brain (local index + Jev decisions)";
      wantedBy = [ "graphical-session.target" ];
      partOf = [ "graphical-session.target" ];
      after = [ "graphical-session.target" ];
      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        WorkingDirectory = "${cfg.repoDir}/brain";
        ExecStart = "${cfg.bunPackage}/bin/bun run ${cfg.repoDir}/brain/src/index.js";
        Restart = "on-failure";
        RestartSec = 2;
        Environment = "JEV_LOG_LEVEL=info";
      };
    };
  };
}
