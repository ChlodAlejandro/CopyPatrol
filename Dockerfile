FROM docker-registry.tools.wmflabs.org/toolforge-php74-sssd-web:latest AS vendor
# ===============================================
#  COMPOSER INSTALL
#  Post-install scripts are run in a later stage.
# ===============================================
ENV COPYPATROL_ROOT=/app
WORKDIR ${COPYPATROL_ROOT}

# Install unzip for safety
RUN apt update && apt install -y unzip

# Copy composer lock file, Symfony config, and bin/ folder
COPY composer.* ${COPYPATROL_ROOT}

RUN composer install --no-scripts

# :~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:

FROM docker-registry.tools.wmflabs.org/toolforge-php74-sssd-web:latest AS base
# ===============================================
#  BASE IMAGE
# ===============================================
ENV COPYPATROL_ROOT=/app
WORKDIR ${COPYPATROL_ROOT}

# == WORK ==

# Disable file error logging for Lighttpd (enables error logging to stderr)
RUN sed -i 's!server.errorlog!# server.errorlog!g' /etc/lighttpd/lighttpd.conf

# Enable required Lighttpd modules (rewrite, php)
RUN lighty-enable-mod fastcgi-php
RUN lighty-enable-mod rewrite

# Add rewrite rules
RUN echo 'url.rewrite-if-not-file += ( "^(/.*)" => "/index.php$0" )' >> /etc/lighttpd/conf-enabled/90-copypatrol.conf

## Everything before this was to set up a Toolforge-like environment
## for local development.

# Symlink CopyPatrol public to document root
RUN rm -rf /var/www/html
RUN ln -s ${COPYPATROL_ROOT}/public /var/www/html

# Set start command (enable FastCGI and start lighttpd)
CMD [ "lighttpd", "-D", "-f", "/etc/lighttpd/lighttpd.conf" ]

FROM base as production
# ===============================================
#  PRODUCTION IMAGE
# ===============================================

# Copy vendor files
COPY --from=vendor ${COPYPATROL_ROOT}/vendor ${COPYPATROL_ROOT}/vendor

# Copy files
COPY . ${COPYPATROL_ROOT}

# Run post-install scripts (which we skipped in the vendor stages)
RUN composer run-script post-install-cmd

FROM base as development
# ===============================================
#  DEVELOPMENT IMAGE
# ===============================================

# add XDebug (if needed)
RUN apt-get clean && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive && \
    apt-get install --yes php7.4-xdebug && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN echo -e "error_reporting=E_ALL\\n\
\\n\
[xdebug]\\n\
xdebug.remote_enable=1\\n\
xdebug.mode=develop,coverage,debug,profile\\n\
xdebug.start_with_request=yes\\n\
xdebug.log=/tmp/xdebug.log\\n\
xdebug.log_level=0\\n\
xdebug.remote_host=host.docker.internal\n\
# XDebug 3\\n\
xdebug.client_host=host.docker.internal\\n" >> /etc/php/7.4/mods-available/xdebug.ini

# Copy vendor files
COPY --from=vendor ${COPYPATROL_ROOT}/vendor ${COPYPATROL_ROOT}/vendor

# Copy files
COPY . ${COPYPATROL_ROOT}

# Run post-install scripts (which we skipped in the vendor stages)
RUN composer run-script post-install-cmd
